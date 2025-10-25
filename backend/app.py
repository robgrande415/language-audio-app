import base64
import json
import os
import re
import tempfile
from typing import Dict, List, Optional

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request, current_app
from flask_cors import CORS
from openai import OpenAI

app = Flask(__name__)
CORS(app)


def _get_openai_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY environment variable is not set.")
    return OpenAI(api_key=api_key)


def _extract_text_from_url(url: str) -> str:
    response = requests.get(url, timeout=20)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    paragraphs = [p.get_text(strip=True) for p in soup.find_all("p")]
    text = "\n".join(filter(None, paragraphs))
    return text.strip()


def extract_dict(text):
    # Find the first { and last }
    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1 or start >= end:
        raise ValueError("No valid dictionary found in text")

    # Extract substring
    dict_str = text[start:end+1]

    # Optional: clean up trailing characters or invalid JSON symbols
    dict_str = re.sub(r'(?s)^.*?({.*})$', r'\1', dict_str.strip())

    # Parse into Python dict
    try:
        data = json.loads(dict_str)
    except json.JSONDecodeError as e:
        raise ValueError(f"Extracted text is not valid JSON: {e}")

    return data

def _extract_response_text(response) -> str:
    if hasattr(response, "output_text"):
        output_text = getattr(response, "output_text")
        if isinstance(output_text, str):
            return output_text.strip()

    pieces: List[str] = []
    for block in getattr(response, "output", []):
        for item in getattr(block, "content", []):
            text = getattr(item, "text", None)
            if isinstance(text, str):
                pieces.append(text)
    if not pieces and hasattr(response, "content") and isinstance(response.content, list):
        for item in response.content:
            if isinstance(item, dict) and "text" in item and isinstance(item["text"], str):
                pieces.append(item["text"])


    return "\n".join(pieces).strip()


def _split_and_translate_sentences(client: OpenAI, sentences: List[str]) -> List[str]:
    if not sentences:
        return []

    schema = """
    {
        raw_text: sentences in french,
        sentences: [
            {"english": English translation of sentence 0, "french": French translation of sentence 0},
            {"english": English translation of sentence 1, "french": French translation of sentence 1},
            ...
            {"english": English translation of sentence N, "french": French translation of sentence N}
        ]
    }
    """

    prompt = {
        "role": "system",
        "content": (
            f"Translate each of the following French sentences into English. "
            f"Return a JSON object using the following format {schema}\n\n"
            f"Sentences: {json.dumps(sentences, ensure_ascii=False)}"
        ),
    }

    message_context = f"You translate French into English and respond using JSON only for a web application.\n Use the format {schema}"
    current_app.logger.info("OpenAI system prompt: %s", message_context) 
    current_app.logger.info("OpenAI prompt: %s", prompt) 
    response = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {
                "role": "system",
                "content": message_context,
            },
            prompt,
        ]
    )

    content = _extract_response_text(response)
    current_app.logger.info("OpenAI response: %s", content) 
    content = extract_dict(content)
    current_app.logger.info("OpenAI response post cleaning: %s", content) 
    if not content:
        raise RuntimeError("Unexpected response format from translation request")

    if "sentences" in content:
        items = content["sentences"]
    else:
        raise RuntimeError("Unable to extract items from JSON")
    current_app.logger.info("items: %s", items) 
    return items


def _response_to_base64_audio(response_obj) -> str:
    audio_bytes: Optional[bytes] = None

    if hasattr(response_obj, "read") and callable(response_obj.read):  # streaming responses
        audio_bytes = response_obj.read()
    elif hasattr(response_obj, "to_bytes") and callable(response_obj.to_bytes):
        audio_bytes = response_obj.to_bytes()
    elif hasattr(response_obj, "content"):
        content = response_obj.content
        if isinstance(content, (bytes, bytearray)):
            audio_bytes = bytes(content)
        elif isinstance(content, list):
            # Some SDK versions expose a list of audio chunks.
            collected = bytearray()
            for chunk in content:
                if isinstance(chunk, (bytes, bytearray)):
                    collected.extend(chunk)
                elif isinstance(chunk, dict) and "audio" in chunk:
                    value = chunk["audio"]
                    if isinstance(value, str):
                        try:
                            collected.extend(base64.b64decode(value))
                        except Exception:  # noqa: BLE001
                            continue
                    elif isinstance(value, (bytes, bytearray)):
                        collected.extend(value)
            if collected:
                audio_bytes = bytes(collected)
    elif isinstance(response_obj, (bytes, bytearray)):
        audio_bytes = bytes(response_obj)

    if audio_bytes is None:
        # Fall back to streaming into a temporary file when available.
        if hasattr(response_obj, "stream_to_file") and callable(response_obj.stream_to_file):
            with tempfile.NamedTemporaryFile(suffix=".mp3") as temp_file:
                response_obj.stream_to_file(temp_file.name)  # type: ignore[arg-type]
                temp_file.seek(0)
                audio_bytes = temp_file.read()

    if not audio_bytes:
        raise RuntimeError("Unable to extract audio data from OpenAI response")

    return base64.b64encode(audio_bytes).decode("utf-8")


def _synthesize_audio(client: OpenAI, text: str) -> str:
    speech_response = client.audio.speech.create(
        model="gpt-4o-mini-tts",
        voice="alloy",
        input=text,
    )
    return _response_to_base64_audio(speech_response)


def _build_segments(client: OpenAI, text: str) -> List[Dict[str, str]]:
    sentence_pairs = _split_and_translate_sentences(client, text)

    current_app.logger.info("build segments starting...")
    segments: List[Dict[str, str]] = []
    for index, pair in enumerate(sentence_pairs):
        french = (pair.get("french") or "").strip()
        english = (pair.get("english") or "").strip()
        if not french or not english:
            current_app.logger.info("Skipping :", pair)
            continue
        french_audio = _synthesize_audio(client, french)
        english_audio = _synthesize_audio(client, english)
        segments.append(
            {
                "id": index,
                "french": french,
                "english": english,
                "audio_fr": french_audio,
                "audio_en": english_audio,
            }
        )

    return segments


@app.post("/api/fetch-text")
def fetch_text():
    data = request.get_json(silent=True) or {}
    source_type = data.get("sourceType")

    if source_type == "url":
        url = data.get("url")
        if not url:
            return jsonify({"error": "A URL is required."}), 400
        try:
            text = _extract_text_from_url(url)
        except requests.RequestException as error:
            return jsonify({"error": f"Failed to retrieve article: {error}"}), 502
    elif source_type == "prompt":
        prompt = data.get("prompt")
        if not prompt:
            return jsonify({"error": "A prompt is required."}), 400
        try:
            client = _get_openai_client()
            response = client.responses.create(
                model="gpt-4o-mini",
                input=[
                    {
                        "role": "system",
                        "content": (
                            "You are an assistant that writes French passages suitable for "
                            "language learners."
                        ),
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    },
                ],
            )
            generated_text = _extract_response_text(response)
            text = generated_text.strip()
        except Exception as error:  # noqa: BLE001
            return jsonify({"error": f"Unable to generate text: {error}"}), 500
    elif source_type == "text":
        text = data.get("text", "").strip()
        if not text:
            return jsonify({"error": "Text input is empty."}), 400
    else:
        return jsonify({"error": "Unsupported source type."}), 400

    if not text:
        return jsonify({"error": "No text could be extracted."}), 404

    return jsonify({"text": text})


@app.post("/api/generate-audio")
def generate_audio():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"error": "Text is required to generate audio."}), 400

    try:
        client = _get_openai_client()
        segments = _build_segments(client, text)
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 500
    except Exception as error:  # noqa: BLE001
        return jsonify({"error": f"Unable to generate audio: {error}"}), 500

    return jsonify({"segments": segments})


@app.get("/api/health")
def health_check():
    return jsonify(status="ok")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3030, debug=True)
