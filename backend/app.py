from flask import Flask, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


@app.get("/api/hello")
def hello_world():
    """Return a friendly greeting."""
    return jsonify(message="Hello from Flask!")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3030, debug=True)
