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
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/118.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.google.com/",
    }
    response = requests.get(url, headers=headers, timeout=20)
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
            {
                "english": English translation of sentence 0,
                "french": French translation of sentence 0,
                "key_vocab": [
                    {"french": "key french word", "english": "english meaning"},
                    ...
                ]
            },
            ...
        ]
    }
    """

    prompt = {
        "role": "system",
        "content": (
            f"Translate each of the following French sentences into English. "
            f"Return a JSON object using the following format {schema}\n\n"
            f"For each sentence include a key_vocab list with 2-5 important, non-obvious French words or short phrases "
            f"that could confuse a learner. Provide the original French and a concise English gloss.\n\n"
            f"Sentences: {json.dumps(sentences, ensure_ascii=False)}"
        ),
    }

    message_context = (
        f"You translate French into English and respond using JSON only for a web application.\n"
        f"Use the format {schema} and ensure key_vocab items focus on challenging or idiomatic terms while avoiding obvious words."
    )
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


def _synthesize_audio(client: OpenAI, text: str, language: str) -> str:
    speech_response = client.audio.speech.create(
        model="gpt-4o-mini-tts",
        voice="alloy",
        speed=1,
        input=text,
        instructions="Input is in " + language
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
        french_audio = _synthesize_audio(client, french, 'french')
        english_audio = _synthesize_audio(client, english, 'english')
        key_vocab_audio: List[Dict[str, str]] = []
        raw_key_vocab = pair.get("key_vocab")
        if isinstance(raw_key_vocab, list):
            for vocab_index, vocab in enumerate(raw_key_vocab):
                vocab_fr = (vocab.get("french") or "").strip()
                vocab_en = (vocab.get("english") or "").strip()
                if not vocab_fr or not vocab_en:
                    continue
                vocab_fr_audio = _synthesize_audio(client, vocab_fr, 'french')
                vocab_en_audio = _synthesize_audio(client, vocab_en, 'english')
                key_vocab_audio.append(
                    {
                        "id": f"{index}-{vocab_index}",
                        "french": vocab_fr,
                        "english": vocab_en,
                        "audio_fr": vocab_fr_audio,
                        "audio_en": vocab_en_audio,
                    }
                )
        segments.append(
            {
                "id": index,
                "french": french,
                "english": english,
                "audio_fr": french_audio,
                "audio_en": english_audio,
                "key_vocab": key_vocab_audio,
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


@app.post("/api/translate-sentences")
def translate_sentences():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"error": "Text is required to translate."}), 400

    try:
        client = _get_openai_client()
        sentence_pairs = _split_and_translate_sentences(client, text)
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 500
    except Exception as error:  # noqa: BLE001
        return jsonify({"error": f"Unable to translate sentences: {error}"}), 500

    prepared_pairs = []
    for index, pair in enumerate(sentence_pairs):
        french = (pair.get("french") or "").strip()
        english = (pair.get("english") or "").strip()
        if not french or not english:
            continue
        key_vocab_items: List[Dict[str, str]] = []
        raw_key_vocab = pair.get("key_vocab")
        if isinstance(raw_key_vocab, list):
            for vocab in raw_key_vocab:
                vocab_fr = (vocab.get("french") or "").strip()
                vocab_en = (vocab.get("english") or "").strip()
                if not vocab_fr or not vocab_en:
                    continue
                key_vocab_items.append({"french": vocab_fr, "english": vocab_en})

        prepared_pairs.append(
            {
                "id": index,
                "french": french,
                "english": english,
                "key_vocab": key_vocab_items,
            }
        )

    if not prepared_pairs:
        return jsonify({"error": "No sentences were detected in the provided text."}), 422

    return jsonify({"sentences": prepared_pairs})


@app.post("/api/generate-segment-audio")
def generate_segment_audio():
    data = request.get_json(silent=True) or {}
    french = (data.get("french") or "").strip()
    english = (data.get("english") or "").strip()

    if not french or not english:
        return jsonify({"error": "Both French and English sentences are required."}), 400

    raw_key_vocab = data.get("key_vocab")
    sanitized_key_vocab: List[Dict[str, str]] = []
    if isinstance(raw_key_vocab, list):
        for vocab in raw_key_vocab:
            vocab_fr = (vocab.get("french") or "").strip()
            vocab_en = (vocab.get("english") or "").strip()
            if not vocab_fr or not vocab_en:
                continue
            sanitized_key_vocab.append({"french": vocab_fr, "english": vocab_en})

    try:
        client = _get_openai_client()
        french_audio = _synthesize_audio(client, french, 'french')
        english_audio = _synthesize_audio(client, english, 'english')
        key_vocab_audio: List[Dict[str, str]] = []
        for vocab_index, vocab in enumerate(sanitized_key_vocab):
            vocab_fr_audio = _synthesize_audio(client, vocab["french"],'french')
            vocab_en_audio = _synthesize_audio(client, vocab["english"],'english')
            key_vocab_audio.append(
                {
                    "id": f"{vocab_index}",
                    "french": vocab["french"],
                    "english": vocab["english"],
                    "audio_fr": vocab_fr_audio,
                    "audio_en": vocab_en_audio,
                }
            )
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 500
    except Exception as error:  # noqa: BLE001
        return jsonify({"error": f"Unable to synthesize audio: {error}"}), 500

    return jsonify({"audio_fr": french_audio, "audio_en": english_audio, "key_vocab": key_vocab_audio})


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
