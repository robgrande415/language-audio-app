import base64
import json
import os
import re
import tempfile
from typing import Dict, List, Optional

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
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


def _split_into_sentences(text: str) -> List[str]:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return []
    # Simple sentence segmentation that keeps punctuation marks with sentences.
    pattern = r"(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý0-9])"
    sentences = re.split(pattern, cleaned)
    sentences = [sentence.strip() for sentence in sentences if sentence.strip()]
    return sentences


def _translate_sentences(client: OpenAI, sentences: List[str]) -> List[str]:
    if not sentences:
        return []

    prompt = {
        "role": "user",
        "content": (
            "Translate each of the following French sentences into English. "
            "Return a JSON object that contains a `translations` array. "
            "Each entry must include the sentence `index` (starting at 0) and "
            "the translated English sentence in the `english` field.\n\n"
            f"Sentences: {json.dumps(sentences, ensure_ascii=False)}"
        ),
    }

    schema: Dict[str, object] = {
        "name": "sentence_translations",
        "schema": {
            "type": "object",
            "properties": {
                "translations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {"type": "integer"},
                            "english": {"type": "string"},
                        },
                        "required": ["index", "english"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["translations"],
            "additionalProperties": False,
        },
    }

    response = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {
                "role": "system",
                "content": "You translate French into English and respond using JSON only.",
            },
            prompt,
        ],
        response_format={"type": "json_schema", "json_schema": schema},
    )

    content = _extract_response_text(response)
    if not content:
        raise RuntimeError("Unexpected response format from translation request")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as error:
        raise RuntimeError("Unable to parse translation response as JSON") from error

    items = parsed.get("translations", [])
    translations: Dict[int, str] = {
        int(item["index"]): item["english"].strip()
        for item in items
        if isinstance(item, dict) and "index" in item and "english" in item
    }

    return [translations.get(i, "") for i in range(len(sentences))]


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
        format="mp3",
    )
    return _response_to_base64_audio(speech_response)


def _build_segments(client: OpenAI, text: str) -> List[Dict[str, str]]:
    sentences = _split_into_sentences(text)
    translations = _translate_sentences(client, sentences)

    segments: List[Dict[str, str]] = []
    for index, sentence in enumerate(sentences):
        english = translations[index] if index < len(translations) else ""
        french_audio = _synthesize_audio(client, sentence)
        english_audio = _synthesize_audio(client, english or sentence)
        segments.append(
            {
                "id": index,
                "french": sentence,
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
