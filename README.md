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
- **Integrations:** Google Gemini, Razorpay, Brevo transactional email API

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
| `NODE_VERSION` | Render | Node.js version used for the service; set to `22`. |
| `GENERATE_SOURCEMAP` | Render | Set to `false` to reduce frontend build memory usage. |
| `MONGODB_URI` | Yes in production | MongoDB connection string. |
| `JWT_SECRET` | Yes in production | Secret used to sign and verify login tokens. Use a unique, strong value. |
| `JWT_EXPIRES_IN` | No | Token lifetime; defaults to `7d`. |
| `CLIENT_URL` | No | Frontend origin allowed by CORS. Comma-separated origins are accepted. |
| `CLIENT_URLS` | No | Additional comma-separated frontend origins allowed by CORS. |
| `GEMINI_API_KEY` | For AI recommendations | Google Gemini API key. |
| `RAZORPAY_KEY_ID` | For payments | Razorpay key ID. |
| `RAZORPAY_KEY_SECRET` | For payments | Razorpay secret; keep it private. |
| `EMAIL_API_KEY` | For email OTP | Brevo transactional email API key. |
| `FROM_EMAIL` | For email OTP | Verified sender email address configured in Brevo. |

Frontend build-time variables:

| Variable | Purpose |
| --- | --- |
| `REACT_APP_API_URL` | API base URL, including `/api`. Use `/api` when frontend and backend are served by the same domain. |
| `REACT_APP_SOCKET_URL` | Optional Socket.IO server origin. If omitted, chat derives it from `REACT_APP_API_URL` or the current page origin. |
| `REACT_APP_RAZORPAY_KEY_ID` | Public Razorpay key ID for the payment UI. |

For Create React App, frontend variables must be present when the frontend is built; changing hosting environment values requires a new frontend build/deployment.

## Deploy frontend and backend together on Render

The [`render.yaml`](./render.yaml) Blueprint defines a **single Node web service** named `flex`. Render builds the React frontend during deployment, then starts the Express backend, which serves the frontend, REST API, and Socket.IO WebSocket on the same domain. Do not create a separate Render Static Site for this setup.

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint**, select this repository, and apply the Blueprint.
3. In the `flex` service's environment settings, set `MONGODB_URI` to your production MongoDB connection string and `JWT_SECRET` to a strong, unique secret. Render prompts for values marked `sync: false` in `render.yaml`; fill in only the integrations you use, including Brevo's `EMAIL_API_KEY` and verified `FROM_EMAIL` for email OTP.
4. The Blueprint sets `REACT_APP_API_URL=/api`, so frontend API calls use the same domain. Chat connects to that domain over WebSocket as well.
5. Set `CLIENT_URL` to the exact public origin of the combined service (scheme and hostname only, no path or trailing slash), for example `https://flex.onrender.com`. Render will ask for it when you apply the Blueprint. If you use multiple frontend origins, add them as a comma-separated `CLIENT_URLS` environment variable.
6. Add any integration credentials you use (`GEMINI_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `REACT_APP_RAZORPAY_KEY_ID`, `EMAIL_API_KEY`, and `FROM_EMAIL`) to the same Render service's environment settings. Keep secrets out of `render.yaml` and GitHub.

The Render Blueprint keeps the frontend and backend in one Node web service: it installs dependencies from both lockfiles, builds `frontend/build` with `GENERATE_SOURCEMAP=false`, and starts Express, which serves the Flex app, `/api/...` routes, and Socket.IO on the same domain. `NODE_VERSION=22` provides the built-in `fetch` used for Brevo's HTTPS email API. `/health` always returns HTTP `200` with the process status and MongoDB connection state so Render can monitor the running service; `/health/db` returns HTTP `503` until MongoDB connects and HTTP `200` afterward.
