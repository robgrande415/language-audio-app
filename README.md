# language-audio-app

App to learn language grammar and words using audio.

## Development setup

This repository now contains a minimal full-stack "Hello World" example with a Flask backend and a React (Vite) frontend. The two services run independently so that you can iterate on each side without rebuilding the other.

### Backend (Flask)

The backend API listens on port **3030** to avoid conflicts with more common defaults such as 8080.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
python app.py
```

Once the server is running you can visit <http://localhost:3030/api/hello> to confirm it returns the greeting JSON payload.

### Frontend (React + Vite)

The frontend uses Vite's development server (default port 5173) and requests data from the Flask API.

```bash
cd frontend
npm install
npm run dev
```

After the dev server starts, open the URL printed in the console (by default <http://localhost:5173>) to see the React page display the greeting retrieved from the Flask backend running on port 3030.

## Project structure

```
backend/
  app.py
  requirements.txt
frontend/
  index.html
  package.json
  public/
  src/
    App.jsx
    main.jsx
    styles.css
  vite.config.js
```

Feel free to extend either side of the stack to build out the full language learning experience.
