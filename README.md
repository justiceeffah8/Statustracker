# Status Tracker

A responsive React application for instructor course management, weekly student usage tracking, ALEKS PDF progress syncing, PDF curriculum extraction, and a role-aware ChatGPT course assistant powered by the OpenAI API.

Students upload an official `ALEKS_Pie_Report.pdf`. The server sends its extracted text to OpenAI and records Mastered, Learned, Remaining, and Ready To Learn counts plus matched course-topic statuses. Instructors see each enrolled student's current report progress alongside weekly and total site-visit counts. Ready To Learn is treated as a subset of Remaining, so it is not added to the report total.

Students may also select individual Remaining or Ready To Learn topics to mark them manually complete and select them again to undo. Manual completions are displayed separately from ALEKS Mastered and Learned results, included in the combined progress percentage, and synchronized live to the instructor roster.

Users create an email/password login before profile setup. Instructors then claim a unique display username. Students enter separate First name and Second name fields, which are shown together on their dashboard and the instructor roster. Username reservations are stored in the `usernames` collection. Legacy anonymous profiles receive a one-time prompt that links login credentials to the same Firebase user ID, preserving their data.

## Run it in VS Code

### Prerequisites

- Install [Node.js](https://nodejs.org/) 20 or newer.
- Install [Visual Studio Code](https://code.visualstudio.com/).
- Create a Firebase project for authentication and data storage.
- Create an API key in the [OpenAI Platform](https://platform.openai.com/api-keys) for the AI features.

### 1. Open the project

1. Open VS Code.
2. Select **File → Open Folder**.
3. Choose the `Status tracker` folder.
4. Open VS Code's terminal with **Terminal → New Terminal**.

### 2. Install dependencies

```powershell
npm install
```

### 3. Create the environment file

In PowerShell:

```powershell
Copy-Item .env.example .env
```

Open `.env` in VS Code and replace every placeholder value. `.env` is ignored by Git so your OpenAI key is not committed.

### 4. Configure Firebase

1. Go to the [Firebase console](https://console.firebase.google.com/) and create a project.
2. On the project overview, add a **Web app**.
3. Copy the displayed `firebaseConfig` object into `VITE_FIREBASE_CONFIG` in `.env`. It must be valid JSON on one line.
4. In Firebase, open **Authentication → Sign-in method** and enable **Email/Password** authentication. Anonymous authentication may remain enabled temporarily while existing profiles complete the one-time account upgrade.
5. Open **Firestore Database** and create a database.
6. Publish the rules from `firestore.rules` in **Firestore Database → Rules**.
7. Copy the Firebase config's `apiKey` value into `FIREBASE_WEB_API_KEY`. This lets the server validate signed-in users before spending OpenAI API quota.

Republish `firestore.rules` after pulling changes. The app writes student-owned records to `usage` and `progressReports` and reserves instructor names in `usernames`; without the updated rules, those features will show permission errors.

### 5. Configure the OpenAI API

1. Sign in to the [OpenAI Platform](https://platform.openai.com/).
2. Open [API keys](https://platform.openai.com/api-keys) and create a secret key.
3. Copy the key and paste it after `OPENAI_API_KEY=` in `.env`.
4. Keep `OPENAI_MODEL=gpt-5.4-mini`, or select another Responses API model available to your project. You may set `OPENAI_FALLBACK_MODEL` to use a second model after temporary server failures.
5. Never put this key in a variable beginning with `VITE_`; those values are shipped to the browser.

The app uses OpenAI's Responses API through `server/openai-core.mjs`. The browser calls `/api/openai`, while the local server reads `OPENAI_API_KEY` privately from `.env`.

### 6. Start the website

```powershell
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173). The command starts both:

- the Vite React website on port `5173`;
- the private local API server on port `8787`.

You can also press **Ctrl+Shift+B** in VS Code and select **Status Tracker: Run development server**.

### 7. Verify the project

```powershell
npm run test:api
npm run build
```

The API tests use mocked OpenAI responses and do not spend API quota.

## ALEKS progress workflow

1. An instructor creates a course and uploads the ALEKS syllabus plus any course schedule, topic list, or pacing guide PDFs.
2. A student joins that course and opens **Student Usage**.
3. The student uploads a PDF named `ALEKS_Pie_Report.pdf` (Windows duplicate names such as `ALEKS_Pie_Report (1).pdf` are also accepted).
4. ChatGPT extracts the report summary and matches ALEKS topic titles to the instructor's course topics.
5. The student's page and the instructor's roster update automatically through Firestore listeners.

Only PDF files up to 10 MB are accepted. The app stores report counts and matched topic statuses, not the uploaded PDF, ALEKS login, or ALEKS student ID. A site visit is counted once when a student session loads, then aggregated by the Monday-starting week.

## Deploy with Firebase App Hosting

This Vite application uses `server/production.mjs` to serve the built SPA and the protected `/api/openai` endpoint from one App Hosting container. Before the first deployment, create the OpenAI secret referenced by `apphosting.yaml`:

```powershell
firebase apphosting:secrets:set openaiApiKey
```

Paste the OpenAI API key only when Firebase prompts for the secret value. Then deploy the application and Firestore rules:

```powershell
firebase deploy
firebase deploy --only firestore:rules
```

The deployment excludes `.env`; do not remove that exclusion. App Hosting supplies the public Firebase web configuration automatically during the build. At runtime, Firebase Admin verifies signed-in users using the App Hosting service identity.

## Where the important code lives

- `status_tracker.tsx` — React interface and Firebase workflows.
- `server/openai-core.mjs` — protected OpenAI integration shared by local and deployed environments.
- `server/local-api.mjs` — local Node API server.
- `api/openai.ts` — serverless deployment adapter.
- `.env.example` — environment-variable template.
- `firestore.rules` — starter Firebase access rules.

## Important security notes

- Do not commit `.env` or paste your OpenAI key into React code.
- Rotate the OpenAI key immediately if it is exposed.
- The starter Firestore data layout lets authenticated users read public course-tracker collections because the current UI subscribes to them globally. Before serving unrelated schools or organizations, migrate data into per-course or per-tenant collections and tighten read rules.
- Add Firebase App Check, monitoring, and persistent rate limiting before a public production launch.
