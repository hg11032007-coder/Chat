\# Sandeep Chat — Social chat + Stories + Nova AI



A modern, responsive private chat application with a dark neon interface inspired by the provided reference. The product name remains \*\*Sandeep Chat\*\*.



\## Features included



\- Responsive desktop and mobile interface

\- Login and account registration

\- Real-time one-to-one chat with Socket.IO

\- Online/offline and last-seen status

\- Typing indicator

\- Sent, delivered, and seen ticks

\- Reply, edit, copy, and delete message actions

\- Close-chat control; messages are marked seen only while that conversation is explicitly open in a visible, focused browser window

\- Photo, video, document, and file sharing (maximum 25 MB)

\- Browser-based voice-note recording

\- Friend search, received/sent requests, accept/decline/cancel

\- Block, unblock, and hide-chat controls

\- Social Home feed with text/photo/video posts

\- Likes, comments, share text, and post deletion

\- Photo, video, and text Stories that expire after 24 hours

\- Profile photo, display name, bio, counters, and post gallery

\- Nova AI chat with recent conversation context

\- Dark/light theme

\- Admin dashboard with live online/offline status, exact last-online time, message delivery/seen status, exact seen time, user management, and deleted-message restore



> Voice/video calling, groups, reels, camera filters, live location, and true end-to-end encryption are intentionally not included in this version. These require a separate second phase and, for calls, WebRTC/STUN/TURN infrastructure.



\## Setup on Windows / laptop



1\. Install \*\*Node.js 20 or newer\*\*.

2\. Extract the project ZIP.

3\. Open Command Prompt/PowerShell inside the project folder.

4\. Run:



&#x20;  ```bash

&#x20;  npm install

&#x20;  ```



5\. Copy `.env.example` and rename the copy to `.env`.

6\. Change `JWT\_SECRET` to a long random private value.

7\. Optional: add an OpenRouter-compatible API key as `OPENAI\_API\_KEY` to enable Nova AI.

8\. Start the app:



&#x20;  ```bash

&#x20;  npm start

&#x20;  ```



9\. Open `http://localhost:3000`.



\## Updating your existing project



\- Keep a backup of your old folder first.

\- You may keep your existing `chat.db`; the server adds the new columns/tables automatically.

\- Replace `server.js`, `public/`, `package.json`, and `package-lock.json` with the updated versions.

\- Keep your own `.env`; never share real API keys or passwords.

\- Run `npm install` once after replacing the files.



\## Environment variables



```env

PORT=3000

JWT\_SECRET=replace-with-a-long-random-secret

ADMIN\_USERNAME=sandeep

OPENAI\_API\_KEY=

OPENAI\_MODEL=openrouter/free

```



`ADMIN\_USERNAME` determines which username becomes the initial admin. For public deployment, use HTTPS, a strong secret, secure backups, and a production-grade hosting/database plan.



