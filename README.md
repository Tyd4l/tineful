# Tineful — a calm kalimba tuner

Tineful walks you through your 17-tine kalimba one tine at a time. It listens through your phone's microphone, shows the note it hears, and tells you which way to tap the tine until it's in tune. Then it moves on to the next one. No ads, no accounts, no tracking, and it works offline.

## Getting it onto your Android phone

Phones only allow the microphone on pages served over `https://`, so the `tineful` folder needs to be put online once. Any free static host works:

- **Netlify:** open https://app.netlify.com/drop, drag the `tineful` folder onto the page, and sign in (free) so the site is kept.
- **GitHub Pages:** create a repository, upload the contents of `tineful`, then turn on Settings → Pages (deploy from the main branch).

Then, on your phone:

1. Open the site's address in Chrome.
2. Tap the ⋮ menu → **Install app** (or **Add to Home screen**).
3. Open Tineful from your home screen and allow the microphone when asked.

From then on it opens like any other app and works without a connection.

## Using it

- Pluck the tine that's highlighted. The tine meter on the right shows how far to slide the tine:
  too low → tap the tip so it slides up (shorter sounds higher); too high → tap the top end so it slides down (longer sounds lower).
- Once the note holds in tune for a moment, the tine turns mint and Tineful moves on by itself.
- **Skip** leaves a tine for later, **Mark as tuned** confirms it yourself, and tapping any tine on the board jumps straight to it.
- **Play** sounds the target note if you'd like to tune by ear.
- Settings: tuning (C major by default, plus G, F and B major, or set each tine yourself), mirrored layout, order (low to high, left to right, right to left), how close counts as in tune (±3, ±5 or ±10 cents), reference pitch, C D E or Do Ré Mi names, light or dark theme, mic sensitivity, keep the screen on, vibrate on success.

Font: Fredoka, under the SIL Open Font License (`fredoka-OFL.txt`).
