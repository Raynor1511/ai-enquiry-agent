// The confirm page: the link's token is in the URL fragment (never sent to a server). Pressing the
// button confirms the submission, then opens the live page. A button rather than an automatic
// confirm, so email link scanners that open every link can't start a demo.
"use strict";

const token = location.hash.slice(1);
const go = document.getElementById("go");
const problem = document.getElementById("problem");
const MESSAGES = {
  expired: "This link has expired (they work for 24 hours). Please send your enquiry again.",
  busy: "The demo has reached its limit for today. Please try again tomorrow.",
  unknown: "This link isn't valid. Please use the newest link we emailed you, or send your enquiry again.",
  error: "Something went wrong. Please try again in a minute.",
};

function fail(status) {
  problem.textContent = MESSAGES[status] ?? MESSAGES.error;
  problem.hidden = false;
}

if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
  fail("unknown");
} else {
  go.disabled = false;
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Starting…";
    problem.hidden = true;
    try {
      const res = await fetch("/demo/api/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token }) });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        location.replace(`/demo/e#${token}`);
        return;
      }
      fail(res.status === 429 ? "busy" : body.status);
    } catch {
      fail("error");
    }
    go.disabled = false;
    go.textContent = "Start my demo";
  });
}
