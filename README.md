# Offer Adder (local)

A small Chrome extension that lists unadded card offers on Amex, Chase and Citi
and adds the ones you select. Personal tool, not published to the Web Store.

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Open your issuer's offers page and click the blue **Offers** button (bottom right).

After editing files, click the reload icon on the extension's card, then reload the bank page.

## Notes
- Runs only on `global.americanexpress.com`, `*.chase.com` and `online.citi.com`.
- No permissions, no storage. Calls only the issuers' own endpoints, using your logged-in session.
- It uses the issuers' internal APIs, which can change without notice.
- Automating your account may be restricted by issuer terms.
