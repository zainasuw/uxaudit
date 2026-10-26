---
title: UXAudit
emoji: 🔍
colorFrom: gray
colorTo: blue
sdk: gradio
sdk_version: 6.30.0
python_version: "3.11"
app_file: app.py
pinned: false
---

# UXAudit

**Live site: https://cvdvnu-uxaudit.hf.space**

Paste the address of any public web page and get a design review of it: desktop and phone screenshots, eleven facts the browser can prove about the page, and an AI critique of the visual design with a score out of ten, what works, what needs attention (with evidence, a priority and a suggested change), and what could not be assessed. Your recent audits are kept in your browser so you can come back to them. No account is needed.

The site runs on a free Hugging Face Space. If nobody has used it for a couple of days it goes to sleep, and the first visit then takes two to four minutes to wake it up; after that an audit takes about a minute (roughly twenty seconds of capture and thirty seconds of AI review).

## How an audit works

1. The address is checked: only public `http`/`https` sites are accepted.
2. A sandboxed Chromium opens the page at 1280 × 800 and at 390 × 844, scrolls through it, and captures the viewport, the full page (up to 10,000 px) and a series of frames of each.
3. The page is measured in the browser: title, language, viewport tag, heading structure, image descriptions, button and link names, form labels, generic link text, sideways scrolling on a phone, and tap-target size.
4. All frames, the measured facts and the page title go to Gemini (`gemini-3.5-flash-lite`) with a fixed reviewer instruction. The reply is validated strictly before anything is shown; the review is a design judgement from screenshots and can be wrong.
5. The report appears, and the audit is added to the history in your browser. The server keeps each audit for about an hour; the browser keeps the report text and a small preview for up to twenty audits.

Limits on the public site: 25 audits and 5 AI reviews per visitor per day, 480 reviews per day in total, ten audits queued at a time, two minutes per audit.

## What it checks

| Check | What a problem looks like |
|---|---|
| Page title | No `<title>` |
| Page language | No `lang` on `<html>` |
| Mobile viewport | No viewport meta tag |
| Main heading | Zero or several `<h1>` |
| Heading structure | Skipped levels, e.g. `h2` straight to `h4` |
| Image descriptions | Visible `<img>` without an `alt` attribute |
| Buttons and links with names | Controls with no text, label or alt |
| Form field labels | Fields with only a placeholder |
| Descriptive link text | "Click here", "read more" |
| Horizontal scrolling on mobile | Page wider than a 390 px screen |
| Tap target size on mobile | Controls under 24 × 24 px in the first screen |

These are measured, not judged; the AI review is the judgement.

## Run it yourself

Requirements: Node.js 20.10 or newer and a Gemini API key (the free tier is enough).

```bash
git clone https://github.com/zainasuw/uxaudit.git
cd uxaudit
npm install
npx playwright install chromium        # the browser used for screenshots
cp .env.example .env                   # then put your GEMINI_API_KEY in .env
npm run build
npm start                              # serves the app on port 3131
```

The reviewer instruction is not part of the repository. Point `REVIEW_INSTRUCTION_FILE` in `.env` at a text file with your own instruction (or set `REVIEW_INSTRUCTION` directly); without one, audits still run but the AI review is disabled.

```bash
npm run dev          # run from source without building
npm test             # 34 tests: URL guard, egress proxy, analysis of a fixture page in real Chromium, review validation, API
npm run typecheck
```

### Hosting on a Hugging Face Space

`app.py` is the Space launcher: it installs Node and Chromium, builds the app, starts it on an internal port and relays the Space's public port to it. Set `GEMINI_API_KEY` and `REVIEW_INSTRUCTION_B64` (the instruction, base64-encoded on one line) as Space secrets. The web font is stored through Git LFS because the Space host does not accept raw binary files.

## Safety

- Only public addresses are analyzed. `localhost`, private, link-local and cloud metadata addresses and internal host names are refused, and every request the page itself makes, including redirects and WebSockets, goes through an egress proxy that applies the same rule and pins the resolved address.
- The browser runs sandboxed in an isolated context per audit with WebRTC restricted, a hard time limit and a time-boxed teardown.
- Nothing from a page or from the AI is ever rendered as HTML; all of it is inserted as text. Page content is sent to the model as data, not as instructions, and the model's answer must match a strict shape before it is used.
- The server sets a Content Security Policy, rejects cross-origin requests, accepts only small JSON bodies, uses unguessable audit ids and never lists audits. The API key and the reviewer instruction live only in server environment variables.

## Limitations

- Sites behind bot protection or a login produce an error or a screenshot of the block page.
- The review covers what is visible in static screenshots; hover states, animations, performance and real screen-reader behaviour are out of scope.
- Scores from the model vary by about a point between runs of the same page.
- A host that changes its DNS answer during an analysis is narrowed but not fully blocked.
