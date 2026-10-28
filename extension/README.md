# Attentix: Chrome extension

The extension lets a student join a class and share a live **attention score (0-100)** and **state** (`Focused`,
`Passive`, `Distracted` or `Idle`) from their **Google Meet** or **Zoom web client** tab with their teacher.

It needs **Google Chrome 116 or newer**. The Zoom desktop app is not supported. For setup of the server, see the
[main README](../README.md).

## Install and join

### Easiest: the pre-configured extension from your teacher

Your teacher downloads **Download Pre-Configured Student Extension** from the dashboard and sends you a zip.

1. Unzip it.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and choose the unzipped
   folder.
3. Click the extension, type your **full name** and **email**, tick the consent box and press **Join class**.

The server address and Class Code are already filled in. The address is shown under the form and in **Advanced
settings**; you only need to open that section if you must use a different server.

### Manual: the plain `extension/` folder

Use this for development, or if your teacher only gave you a code. Load the `extension/` folder as above, then fill in all
five fields:

| Field | What to enter |
| --- | --- |
| **Server address** (under *Advanced settings*) | Your teacher's address, such as `http://192.168.1.20:3000` or `https://attention.your-school.edu` |
| **Class Code** | The permanent 6-character code from your teacher. Capital or small letters both work; spaces are ignored. |
| **Full name** | Shown to your teacher on the class list. |
| **Email** | Identifies you in this class. |
| **Consent** | Tick the box. You cannot join without it. |

There is no password and no account. After you join, open your meeting on `meet.google.com` or the Zoom web client. The
toolbar badge shows your live score, and a small label on the meeting page shows the same.

| Badge colour | Meaning |
| --- | --- |
| Green | Focused |
| Blue | Passive |
| Red | Distracted |
| Grey | Idle, or `--` when you have joined but there is no reading yet (open your meeting tab) |
| Amber (`...`) | Reconnecting to the server |

**Joining again** with the same email and Class Code (new browser, expired session) gives you back the same place in the
class. The same email in a *different* class is a separate record, so nothing leaks between classes.

**Open Web Dashboard** shows what your teacher sees about you, and lets you withdraw consent or delete your data.
**Switch Class / Disconnect** stops sharing, ends your session on the server and clears it from the browser.

## Permissions

| Permission | Why the extension needs it |
| --- | --- |
| `storage` | Keeps your session in the browser, so you stay joined after Chrome restarts. |
| `alarms` | A timer every 30 seconds wakes the background worker, which Chrome stops when idle, so your session carries on. |
| `scripting` | Loads the extension's page script into a meeting tab that was already open when you installed or updated it. |
| `meet.google.com`, `zoom.us` | The only websites where the extension reads activity signals. It does nothing on other sites. |
| `http://localhost:3000` | The default local server address. |
| Any `http` or `https` address (optional) | Not granted at install. Chrome asks once, when you join a server that is not already listed. |

The pre-configured download also lists your teacher's server, so Chrome does not ask a second time.

## Which server addresses are accepted

Your name and email cross the network, so plain `http://` is accepted **only** for this computer and your own network:
`localhost`, private addresses (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, `169.254.x.x`) and `.local` names. Any other
address must start with `https://`. On a shared Wi-Fi, `http://` traffic can be read by others on that network, so ask your
teacher to use HTTPS where that matters.

## What it shares, and what it never shares

**Shared**, from the Meet or Zoom tab only: whether the tab is in front, how recently you were active, how often you switch
tabs, scrolling, whether audio or video is playing, and keyboard activity as **counts per 3 seconds**. When you send a chat
message in the meeting, only the fact that you did is shared.

**Never shared:** which keys you press, anything you type, chat text, page content, camera, microphone, screenshots or
browsing history.

## How the score works

The extension checks every 2 seconds and sends one reading every 5 seconds (right away when your state changes).

`score = 100 x (0.45 x focus + 0.55 x interaction) - switch penalty`

| Part | Rule |
| --- | --- |
| focus | 1 when the meeting tab is the active tab of the focused window, otherwise 0. |
| interaction | The best of: how recently you were active (1.0 within 15 seconds, falling to 0.6 at 2 minutes, 0.3 at 5 minutes, and never below 0.1), mouse, keyboard or scroll activity spread steadily over the last minute, scrolling or reading (0.90), media playing (0.85), or the Attentix page itself (0.80). It is multiplied by 0.25 when the tab is not in front. |
| switch penalty | 5 points per tab switch in the last 5 minutes (up to 30), plus 15 for 3 or more in the last minute, up to 40 in total. |

**State:** not focused, rapid switching, or a score under 40 means **Distracted**. Active in the last 30 seconds, scrolling,
or steady activity means **Focused**. Quiet but watching media, on the app page, or quiet for under 5 minutes means
**Passive**. Focused but quiet for 5 minutes or more with nothing playing means **Idle**.

The server smooths the score over time, and the popup and badge show that same value, so you see what your teacher sees.
While you are offline they show a local estimate.

## If the connection drops

* If the server cannot be reached, the last 5 readings are kept and sent when it comes back. The extension keeps retrying,
  waiting longer each time (from 1 to 30 seconds).
* After 12 seconds without a live connection, readings are sent over a simpler backup route, so networks that block
  WebSockets still work. Tab-switch and chat events, and your teacher's questions, need the live connection.
* If a banner says the server cannot be reached, press **Retry** in the popup.

## Troubleshooting

| Message | What to do |
| --- | --- |
| No class found for that code | Check the code with your teacher. |
| Agree to the privacy notice to join | Tick the consent box. |
| Chrome needs your permission to contact that server | Press **Join class** again and choose **Allow**. |
| Your session ended or expired | Join the class again. This also happens if consent was withdrawn or you were removed. |

## For educators: `config.js`

`config.js` is the only file that differs between classes. Your server rewrites it for each download. You can also edit it
by hand; a blank value means the student types it in:

```js
globalThis.AMP_PRECONFIG = { serverUrl: "http://192.168.1.20:3000", classCode: "ABC234" };
```

The popup pre-fills from it, and the background worker remembers the server address on install or update. A missing file or
an invalid value is ignored.

## Limitations

* The Zoom desktop app is not supported (web client only).
* Meet in Picture-in-Picture, or on a second monitor while another app has focus, counts as "not in front".
* Chat detection relies on the words Meet and Zoom use for their chat box (`CHAT_HINT` in `content.js`).
* Scores are a rough signal of engagement, not proof of attention.
