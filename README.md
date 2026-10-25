# UXAudit

Paste the address of a public web page and get back a desktop screenshot, a phone screenshot, and a short report of things the browser can prove about the page: a missing main heading, images without descriptions, buttons without names, form fields without labels, sideways scrolling on a phone, and a few more. Each finding explains what it means for visitors and what to change.

Everything runs on your own computer. Nothing is uploaded, and results are stored only in `~/.uxaudit/`.

## Requirements

- Node.js 20.10 or newer
- macOS, Linux or Windows

## Install

```bash
git clone <this repository>
cd uxaudit
npm install
npx playwright install chromium   # downloads the browser used for screenshots (skip if you already have it)
```

## Run

```bash
npm run build
npm start
```

Then open http://127.0.0.1:3131/ in your browser, type a website address such as `tacoma.uw.edu`, and click **Analyze**. Press Ctrl+C in the terminal to stop.

To use a different port: `PORT=4000 npm start`.

## Develop

```bash
npm run dev        # run from source without building
npm test           # 14 tests: URL guard, analysis of a fixture page in real Chromium, and the API
npm run typecheck
```

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
| Horizontal scrolling on mobile | Page wider than a 390px screen |
| Tap target size on mobile | Controls under 24×24px in the first screen |

These are structural checks. They do not judge the design itself.

## Safety notes

The app only opens public `http` and `https` addresses. It refuses `localhost`, private and link-local networks, cloud metadata addresses and internal host names, and it applies the same rule to every request the page makes, including redirects. The server listens on `127.0.0.1` only and rejects cross-origin browser requests. Some sites block automated visitors; when that happens you will see a message rather than a report.

## Limitations

- Sites behind bot protection or a login show an error or an error page.
- One page is analyzed at a time.
- The full-page capture stops at 5000px.
- A host that changes its DNS answer during an analysis is narrowed but not fully blocked.
