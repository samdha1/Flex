# Flex

Flex is a freelancing marketplace that connects clients with freelancers. Clients can publish projects and review proposals; freelancers can discover projects, submit proposals, and get AI-assisted recommendations. The app also includes profiles, reviews, payments, and real-time chat.

## What you can do

- Create an account and sign in with email OTP verification.
- Browse projects and freelancer profiles.
- Post projects as a client and submit proposals as a freelancer.
- View dashboards, manage profiles, and leave project reviews.
- Get AI-powered freelancer and project recommendations.
- Chat in real time using Socket.IO over WebSocket.
- Create payment orders and verify payments with Razorpay.

Some features need credentials from external services. See [Environment variables](#environment-variables).

## Tech stack

- **Frontend:** React 18, React Router, Axios
- **Backend:** Node.js, Express, Socket.IO
- **Database:** MongoDB with Mongoose
- **Integrations:** Google Gemini, Razorpay, SMTP email

## Repository layout

```text
backend/
  middleware/   Authentication middleware
  models/       MongoDB/Mongoose models
  routes/       REST API endpoints
  utils/        Shared backend utilities
  server.js     Express, Socket.IO, and MongoDB startup
frontend/
  src/
    components/ Shared UI components
    context/    Authentication state
    pages/      Application pages
    utils/      API client
render.yaml     Render Blueprint for one combined web service
```

## Run locally

You need Node.js/npm and a MongoDB database. Start the backend and frontend in separate terminals from the repository root.

### 1. Configure and start the backend

In PowerShell:

```powershell
Copy-Item backend\.env.example backend\.env
Set-Location backend
npm ci
npm run dev
```

Edit `backend\.env` and set at least `MONGODB_URI` to your MongoDB connection string. For local development, the example file includes a localhost MongoDB URI. The backend listens on port `5000` by default.

### 2. Start the frontend

In a second terminal:

```powershell
Set-Location frontend
npm ci
npm start
```

The React development server runs on `http://localhost:3000`. The frontend API and chat defaults point to the local backend. To use a different backend, configure `REACT_APP_API_URL` and, optionally, `REACT_APP_SOCKET_URL` before starting/building the frontend.

## Environment variables

Backend variables are documented with safe placeholders in [`backend/.env.example`](./backend/.env.example). Keep actual credentials in your local ignored `.env` file or your hosting provider's secret environment settings. **Never commit real secrets.**

| Variable | Required? | Purpose |
| --- | --- | --- |
| `PORT` | Hosting provides it | HTTP server port; defaults to `5000` locally. |
| `NODE_ENV` | No | Set to `production` on deployment. |
| `MONGODB_URI` | Yes in production | MongoDB connection string. |
| `JWT_SECRET` | Yes in production | Secret used to sign and verify login tokens. Use a unique, strong value. |
| `JWT_EXPIRES_IN` | No | Token lifetime; defaults to `7d`. |
| `CLIENT_URL` | No | Frontend origin allowed by CORS. Comma-separated origins are accepted. |
| `CLIENT_URLS` | No | Additional comma-separated frontend origins allowed by CORS. |
| `GEMINI_API_KEY` | For AI recommendations | Google Gemini API key. |
| `RAZORPAY_KEY_ID` | For payments | Razorpay key ID. |
| `RAZORPAY_KEY_SECRET` | For payments | Razorpay secret; keep it private. |
| `SMTP_HOST`, `SMTP_PORT` | For email OTP | SMTP server address and port. |
| `SMTP_USER`, `SMTP_PASS` | For email OTP | SMTP login credentials. |
| `FROM_EMAIL` | For email OTP | Sender email address. |

Frontend build-time variables:

| Variable | Purpose |
| --- | --- |
| `REACT_APP_API_URL` | API base URL, including `/api`. Use `/api` when frontend and backend are served by the same domain. |
| `REACT_APP_SOCKET_URL` | Optional Socket.IO server origin. If omitted, chat derives it from `REACT_APP_API_URL` or the current page origin. |
| `REACT_APP_RAZORPAY_KEY_ID` | Optional public Razorpay key ID for the payment UI. |

For Create React App, frontend variables must be present when the frontend is built; changing hosting environment values requires a new frontend build/deployment.

## Deploy frontend and backend together on Render

The [`render.yaml`](./render.yaml) Blueprint defines a **single Node web service** named `flex`. Render builds the React frontend during deployment, then starts the Express backend, which serves the frontend, REST API, and Socket.IO WebSocket on the same domain. Do not create a separate Render Static Site for this setup.

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint**, select this repository, and apply the Blueprint.
3. In the `flex` service's environment settings, set `MONGODB_URI` to your production MongoDB connection string and `JWT_SECRET` to a strong, unique secret.
4. The Blueprint sets `REACT_APP_API_URL=/api`, so frontend API calls use the same domain. Chat connects to that domain over WebSocket as well.
5. Set `CLIENT_URL` to the exact public origin of the combined service (scheme and hostname only, no path or trailing slash), for example `https://flex.onrender.com`. Render will ask for it when you apply the Blueprint. If you use multiple frontend origins, add them as a comma-separated `CLIENT_URLS` environment variable.
6. Add any integration credentials you use (Gemini, Razorpay, SMTP) to the same Render service's environment settings. Keep secrets out of `render.yaml` and GitHub.

The Render build installs dependencies from both lockfiles and builds `frontend/build`. Production startup checks that build exists. The service root serves the Flex app, `/api/...` serves backend routes, and `/health` returns `{"status":"ok"}` after MongoDB connects. If MongoDB is unavailable, `/health` returns HTTP `503`.
