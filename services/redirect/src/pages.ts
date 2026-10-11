/** Static HTML responses. Inlined rather than templated: the 404 page is
 *  served on the hot path and must not cost a file read or a render. */

function shell(title: string, heading: string, body: string, status: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100svh; display: grid; place-items: center;
    padding: 24px;
    font: 400 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #fafaf9; color: #1c1917;
  }
  main { max-width: 32rem; text-align: center; }
  .code { font-size: 0.8125rem; letter-spacing: 0.08em; text-transform: uppercase;
          color: #a8a29e; font-weight: 600; margin: 0 0 12px; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.015em; }
  p  { margin: 0; color: #57534e; }
  @media (prefers-color-scheme: dark) {
    body { background: #0c0a09; color: #fafaf9; }
    p { color: #a8a29e; }
    .code { color: #57534e; }
  }
</style>
</head>
<body>
  <main>
    <p class="code">${status}</p>
    <h1>${heading}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;
}

export const notFoundPage = shell(
  'Link not found',
  'This link doesn&rsquo;t exist',
  'It may have been deleted, or the address may be mistyped.',
  404,
);

export const unknownHostPage = shell(
  'Domain not configured',
  'This domain isn&rsquo;t set up yet',
  'No short links are configured for this hostname.',
  404,
);

export const errorPage = shell(
  'Temporarily unavailable',
  'Something went wrong',
  'This link could not be resolved right now. Please try again shortly.',
  503,
);

export const rootPage = shell(
  'Short link service',
  'Short link service',
  'This domain serves short links. There is nothing at the root address.',
  404,
);
