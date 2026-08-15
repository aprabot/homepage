# Contributing to APRABot

Welcome — this covers everything needed to get this project running on your machine (Windows,
macOS, or Linux — Windows-specific notes are called out explicitly) and start contributing,
whether that's the dashboard/website or the Lambda backend.

## The two repos

APRABot is split across two GitHub repos:

- **[aprabot/homepage](https://github.com/aprabot/homepage)** (this repo) — the marketing site,
  the product dashboard, and the AWS Lambda backend (chat, scenarios API, the forecast pipeline
  runner). This is what most contributions touch.
- **[aprabot/forecast](https://github.com/aprabot/forecast)** — the standalone demand-forecasting
  pipeline (`forecast.py` and friends). It's developed and tested independently, and a **copy** of
  its `forecast.py` gets bundled into this repo's `lambda/scenario-runner` Lambda at deploy time
  (see that Lambda's own README). If your work is purely on the forecasting model/algorithm itself
  — not the product around it — start with **that repo's own `onboarding.html`** instead, which
  has a full walkthrough of the data science side (open it in a browser after cloning, or view it
  [rendered on GitHub](https://github.com/aprabot/forecast/blob/main/onboarding.html) — GitHub
  doesn't render raw HTML inline, so download/clone and open it locally, or ask whoever onboarded
  you for a rendered copy).

This guide is about **this repo**.

## What you can build and test with zero AWS access

Two of this repo's three "layers" need no AWS account, no credentials, nothing beyond Git and a
browser (or Python, for the Lambda layer):

1. **The site/dashboard** — plain HTML/CSS/vanilla JS, no build step, no npm install.
2. **Lambda handler code** — you can write and locally test the Python logic in `lambda/*/handler.py`
   without ever deploying it.

Only **actually deploying** a Lambda change to AWS (`aws lambda update-function-code`) needs
credentials to the live production AWS account. That's a deliberate separation — see
[Deploying (needs AWS access)](#deploying-needs-aws-access) below for why, and what the workflow
looks like without it.

## Prerequisites

| Tool | Why | Windows notes |
|---|---|---|
| [Git for Windows](https://git-scm.com/download/win) | version control | installs Git Bash too, which behaves like macOS/Linux terminals for anything below |
| [Python 3.12](https://www.python.org/downloads/) | Lambda backend code (matches the Lambda runtime) | during install, check **"Add python.exe to PATH"**. Prefer python.org's installer over the Microsoft Store version — the Store version has caused `venv`/PATH issues for contributors before |
| A code editor | anything works | [VS Code](https://code.visualstudio.com/) is a fine free default if you don't have a preference |
| [AWS CLI](https://aws.amazon.com/cli/) | **only** if you'll be deploying Lambda changes yourself | not needed just to write/test code |

## Getting the code

This repo is public, so the simplest path is to **fork it** rather than ask for direct push
access — you get your own copy to push to, and open pull requests back to `aprabot/homepage`
from there, without anyone needing to grant you write access up front.

1. Click **Fork** on [github.com/aprabot/homepage](https://github.com/aprabot/homepage).
2. Clone your fork (PowerShell, Git Bash, or any terminal):
   ```
   git clone https://github.com/YOUR-USERNAME/homepage.git
   cd homepage
   ```
3. Make a branch for whatever you're working on — don't commit straight to `main`:
   ```
   git checkout -b my-change
   ```

(If instead you're added as a direct collaborator on the repo, the same clone/branch steps work
the same way against `aprabot/homepage` directly — just skip the fork.)

## Running the site/dashboard locally

No build step — it's static files. From the repo root, start any local file server and open it
in a browser:

```
python -m http.server 8000
```

Then visit `http://localhost:8000/` for the marketing site, or `http://localhost:8000/dashboard/`
for the product dashboard. (Windows: use `python` or `py -m http.server 8000` in PowerShell —
same command either way once Python's installed and on PATH.)

**What works locally:** layout, styling, static content, most vanilla-JS UI logic (charts, modals,
navigation, the guided walkthrough, etc.).

**What won't work locally:** anything that calls the live backend — logging in (Cognito), loading
real forecast data, running scenarios, chatting with Lyra. Those hit real AWS API Gateway
endpoints hardcoded in the JS files (e.g. `js/main.js`, `js/scenarios.js`) that only serve
requests from a signed-in session against the real Cognito user pool. You can still read/edit that
code locally; you just won't see live data without a real login.

## Working on the Lambda backend

Each Lambda lives in its own folder under `lambda/` — `chat-api`, `scenarios-api`,
`scenario-runner`. `chat-api` and `scenario-runner` each have a `README.md` with **deploy**
instructions specific to that function (they bundle real dependencies — `jpholiday`, or
pandas/LightGBM — with some packaging quirks worth reading first). `scenarios-api` has no
dependencies beyond `boto3` (already available in the Lambda runtime) and no README — its deploy
is just zipping `handler.py` on its own.

### Local setup (per Lambda you're working on)

You don't need to install AWS SAM or any Lambda-emulation tool — a plain virtualenv with the same
dependencies the Lambda has at runtime is enough to write and unit-test the logic.

```
python -m venv .venv

# Windows (PowerShell)
.venv\Scripts\Activate.ps1
# Windows (cmd.exe)
.venv\Scripts\activate.bat
# macOS/Linux
source .venv/bin/activate

pip install boto3 pandas openpyxl jpholiday   # only what the specific handler.py imports
```

> **Windows PowerShell:** if `Activate.ps1` fails with *"running scripts is disabled on this
> system"*, that's PowerShell's default execution policy, not a bug in this repo:
> ```
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
> (or `-Scope Process` to only allow it for the current window, no persistent change), then re-run
> `Activate.ps1`. Or just use `activate.bat` in `cmd.exe` instead, which isn't affected by this
> setting at all.

### Testing handler code without deploying it

Every `handler.py` calls out to real AWS services (`boto3.client('s3')`, `bedrock-runtime`, etc.)
— to test locally, swap those clients for a fake before importing/calling into the module, so
nothing ever touches a real AWS account:

```python
import sys, importlib.util
import boto3

# fake out the AWS clients before the handler module is loaded
class FakeS3:
    def get_object(self, Bucket, Key):
        return {'Body': open('some_local_test_file.json', 'rb')}
boto3.client = lambda *a, **kw: FakeS3() if a and a[0] == 's3' else None

spec = importlib.util.spec_from_file_location("handler", "lambda/chat-api/handler.py")
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)

# now call functions directly, e.g.:
print(handler.build_data_summary())
```

This is genuinely how backend changes in this repo get validated before ever touching AWS —
build a small synthetic input, mock the S3/boto3 calls, call the real function, and check the
output makes sense. At minimum, always run:

```
python -m py_compile lambda/<function>/handler.py
```

to catch syntax errors before opening a PR.

## Git workflow

- Branch off `main`, one focused change per branch/PR.
- Commit messages: short imperative present tense ("Add X", "Fix Y"), a body paragraph explaining
  *why* if it's not obvious from the diff — see `git log` for the existing style.
- Open a PR against `aprabot/homepage`'s `main` branch. Merging a PR **auto-deploys the static
  site** to aprabot.com within about a minute (GitHub Pages watches `main` directly — no CI config
  file, it's just enabled in the repo's Pages settings). It does **not** auto-deploy any Lambda
  changes — see below.

## Deploying (needs AWS access)

Lambda code changes are **not** deployed automatically on merge — someone with AWS CLI credentials
to the production account has to run the deploy steps documented in that Lambda's own
`README.md` (roughly: zip the handler + dependencies, upload to S3, `aws lambda
update-function-code`). This is deliberate: the AWS account behind this product is live and
serves real (anonymized) business data, so credential access is handed out separately from
GitHub write access.

**Practically, this means:** write and locally test your Lambda change, open a PR as normal, and
whoever holds AWS deploy access reviews + deploys it. If you'll be doing this regularly, ask about
getting your own scoped AWS credentials at that point — it's a separate conversation from getting
the code itself working.
