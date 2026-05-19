# QStore IMS v2

Inventory management system for Australian Army Cadet Q-Store operations.
Single-file HTML application — no server, no installation, no internet required.

## Quick start (non-technical)

1. Copy the `qstore.html` file to your computer (or open it directly from the USB/shared drive)
2. Double-click the file — it opens in your default web browser
3. At first launch, log in as **Administrator** with PIN **0000**
4. Change the default PIN when prompted, then set up your unit details in **Settings**

**Browser requirements:** Chrome, Edge, Firefox, or Safari (desktop). The app will not work in Internet Explorer.

**Data storage:** Everything is saved in the browser on the device you open the file on. Closing the file does not delete your data. To use the same data on a different device, use **Settings → Data → Export backup**, then **Import backup** on the other device.

> For full instructions, see [MANUAL.md](MANUAL.md).

## For developers

```
npm install
npm run build          # outputs dist/qstore.html + docs/index.html
npm run build -- --dist --recipient="Unit Name"   # named distribution copy
node test-*.mjs        # run individual test suites
```

Build output is a single self-contained HTML file with all CSS and JS inlined.
