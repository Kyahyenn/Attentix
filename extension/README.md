# Attentix: Chrome extension

The extension lets a student join a class and share a live **attention score (0-100)** and **state** (`Focused`,
`Passive`, `Distracted` or `Idle`) from their **Google Meet** or **Zoom web client** tab.

Needs **Google Chrome 116 or newer**. The Zoom desktop app is not supported. For server setup, see the
[main README](../README.md).

## Install and join

### Easiest: the pre-configured extension from your teacher

1. Your teacher downloads **Download Pre-Configured Student Extension** from the dashboard and sends you a zip.
2. Unzip it.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick the unzipped
   folder.
4. Click the extension, enter your **full name** and **email**, tick the consent box and press **Join class**.

The server address and Class Code are already filled in. Open **Advanced settings** only if you must use a different
server.

### Manual: the plain `extension/` folder

Use this for development, or if your teacher only gave you a code. Load the `extension/` folder the same way, then fill
in:

| Field | What to enter |
| --- | --- |
| **Server address** (under *Advanced settings*) | Your teacher's address, such as `http://192.168.1.20:3000` or `https://attention.your-school.edu` |
| **Class Code** | The 6-character code from your teacher. Capital or small letters both work; spaces are ignored. |
| **Full name** | Shown to your teacher on the class list. |
| **Email** | Identifies you in this class. |
| **Consent** | Tick the box. You cannot join without it. |

There is no password and no account.

## After you join

Open your meeting on `meet.google.com` or the Zoom web client. The toolbar badge and a small label on the meeting page
show your live score.

| Badge colour | Meaning |
| --- | --- |
| Green | Focused |
| Dark gold | Passive |
| Red | Distracted |
| Grey | Idle, or `--` when there is no reading yet (open your meeting tab) |
| Amber (`...`) | Reconnecting to the server |

* **Join again** with the same email and Class Code (new browser, expired session) to get back your place. The same email
  in a *different* class is a separate record.
* **Open Web Dashboard** shows what your teacher sees about you and lets you withdraw consent or delete your data.
* **Switch Class / Disconnect** stops sharing, ends your session on the server and clears it from the browser.

## What it shares

**Shared** (from the Meet or Zoom tab only): whether the tab is in front, how recently you were active, how often you
switch tabs, scrolling, whether audio or video plays, and keyboard activity as **counts per 3 seconds**. When you send a
chat message, only the fact that you did is shared.

**Never shared:** which keys you press, anything you type, chat text, page content, camera, microphone, screenshots or
browsing history.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Keeps your session so you stay joined after Chrome restarts. |
| `alarms` | A 30-second timer wakes the background worker, which Chrome stops when idle. |
| `scripting` | Loads the page script into a meeting tab that was already open when you installed or updated. |
| `meet.google.com`, `zoom.us` | The only sites where the extension reads activity. It does nothing elsewhere. |
| `http://localhost:3000` | The default local server address. |
| Any `http`/`https` address (optional) | Not granted at install. Chrome asks once when you join a server that is not listed. The pre-configured download already lists your teacher's server. |

## Which server addresses are accepted

Your name and email cross the network, so plain `http://` is accepted **only** for this computer and your own network:
`localhost`, private addresses (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, `169.254.x.x`) and `.local` names. Any other
address must start with `https://`.

## How the score works

The extension checks every 2 seconds and sends one reading every 5 seconds (immediately when your state changes).

`score = 100 x (0.45 x focus + 0.55 x interaction) - switch penalty`

| Part | Rule |
| --- | --- |
| focus | 1 when the meeting tab is the active tab of the focused window, otherwise 0. |
| interaction | The best of: recent activity (1.0 within 15 s, falling to 0.6 at 2 min, 0.3 at 5 min, never below 0.1); steady mouse, keyboard or scroll activity over the last minute; scrolling or reading (0.90); media playing (0.85); the Attentix page itself (0.80). Multiplied by 0.25 when the tab is not in front. |
| switch penalty | 5 points per tab switch in the last 5 minutes (up to 30), plus 15 for 3 or more in the last minute, up to 40 in total. |

**State:**

* **Distracted:** tab not in front, rapid switching, or a score under 40.
* **Focused:** active in the last 30 seconds, scrolling, or steady activity.
* **Passive:** quiet but watching media, on the Attentix page, or quiet for under 5 minutes.
* **Idle:** focused but quiet for 5 minutes or more with nothing playing.

The server smooths the score over time, and the popup and badge show that same value. While offline they show a local
estimate.

## If the connection drops

* The last 5 readings are kept and sent when the server is back. The extension retries, waiting 1 to 30 seconds longer
  each time.
* After 12 seconds without a live connection, readings go over a simpler backup route, so networks that block WebSockets
  still work. Tab-switch and chat events, and your teacher's questions, need the live connection.
* If a banner says the server cannot be reached, press **Retry** in the popup.

## Troubleshooting

| Message | What to do |
| --- | --- |
| No class found for that code | Check the code with your teacher. |
| Agree to the privacy notice to join | Tick the consent box. |
| Chrome needs your permission to contact that server | Press **Join class** again and choose **Allow**. |
| Your session ended or expired | Join again. This also happens if consent was withdrawn or you were removed. |

## For teachers: `config.js`

`config.js` is the only file that differs between classes. Your server rewrites it for each download. You can also edit
it by hand; a blank value means the student types it in.

```js
globalThis.AMP_PRECONFIG = { serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' };
```

A missing file or an invalid value is ignored.

## Limitations

* Zoom desktop app is not supported (web client only).
* Meet in Picture-in-Picture, or on a second monitor while another app has focus, counts as "not in front".
* Chat detection relies on the words Meet and Zoom use for their chat box (`CHAT_HINT` in `content.js`).
* Scores are a rough signal, not proof of attention.
