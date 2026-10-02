# Long Distance Photobooth

Two people in different places open the same link, see and hear each other live, and take a photo strip together. A shared countdown runs on both screens, each camera takes its own photo at full quality, and both people get the same strip to save.

## What's inside

- **Voice chat** with mute, speaker and volume controls, plus a ring that lights up around whoever is talking.
- **Booth sounds**: countdown beeps, a shutter click, a printer whirr and chimes when someone joins or leaves. They are made in the browser, so there are no sound files. Turn them off with the note button.
- **Live reactions**: hearts and laughs float across both screens.
- **Pose ideas**: a suggestion for every photo, the same on both screens.
- **Countdown length**: 3, 5 or 10 seconds.
- **Names**: each person can put their name on their video.
- **Together in one frame**: both people are cut out of their cameras and put into ONE picture, with no line between them. Each person drags themselves to move, pinches or scrolls to resize, and can step in front or behind. Both screens build the exact same photo.
- **Backgrounds**: your own photo (shared with the other person, so you both stand in it), photo-style scenes (studio, city lights, golden hour, fairy lights, sunset, café) and drawn ones (beach, night sky, blossoms, clouds, hearts, cozy room). People are tinted slightly to match the scene's light and get a soft shadow. The cut-out runs in the browser with Google's MediaPipe; no video leaves the two devices.
- **Background blur** like portrait mode: none, soft, medium or strong, for any scene or for your own room.
- **Times and places**: the strip can print both people's local times and cities ("9:14 PM in Manila · 2:14 PM in London") and a countdown to the next time you meet ("47 days until we meet ♥"), which also shows in the booth.
- **Filters** with a live preview: original, black and white, sepia, warm, cool, soft and pop.
- **Strip styling**: eight pastel papers or any colour you pick, patterns, strip or grid layout, square or rounded corners, stickers, three caption fonts, and the date on or off. When two people are connected, every change shows up on both screens.
- **Colour themes** for the site itself: blush, lilac, mint, sky and peach (the dots in the top corner).
- **This visit**: every strip you take stays available until you close the page.
- **Saving that works on phones**: on a computer "Save strip" downloads the picture. On a phone it opens a save sheet with "Save to Photos" and pictures you can press and hold to save, plus each photo on its own.
- **Leave button**: leaves the booth, turns the camera and microphone off and tells the other person.
- **Booth limits**: when opening a booth, choose how long the link works (1 hour, 1 day, 1 week or no limit) and how many strips can be taken (3, 5, 10 or no limit).

It is a plain static site: no build step, no backend, no database, no accounts.

## Deploy to Vercel

**With GitHub (recommended)**

1. Create a new repository on GitHub and upload everything in this folder to it.
2. Go to vercel.com, sign in with GitHub, and choose **Add New > Project**.
3. Import the repository. Leave the framework preset as **Other** and leave the build settings empty.
4. Press **Deploy**. Your site is live at `your-project.vercel.app`, and every push to GitHub redeploys it.

**With the Vercel CLI**

```
npm i -g vercel
cd long-distance-photobooth
vercel          # preview deployment
vercel --prod   # live deployment
```

## Try it

1. Open your site and press **Open a booth**, then **Turn on camera**.
2. Copy the link and open it on a second device (your phone on mobile data is a good test).
3. Press **Start photos** on either device.

You can also press **Take photos alone** to check the camera and strip without a second person.

To run it on your own computer first: `npx serve .` and open the address it prints. The camera only works on `https://` sites and on `localhost`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | All the screens: landing page, camera step, booth, finished strip |
| `style.css` | Colours, fonts, layout |
| `app.js` | Connection, countdown, capture, and strip drawing |
| `config.js` | Connection settings, the relay (TURN) address, booth limit defaults |
| `vendor/peerjs.min.js` | PeerJS 1.5.5, the library that connects the two browsers |
| `fonts/` | The three typefaces (open-source, SIL Open Font License) |

## Things you may want to change

- **Site name and text**: edit `index.html`.
- **Colours**: the variables at the top of `style.css` (one block per theme).
- **Countdown lengths**: `COUNTS` and `BETWEEN_MS` at the top of `app.js`.
- **Papers, patterns, filters, stickers, fonts, themes, reactions and pose ideas**: the lists near the top of `app.js`.
- **Default booth limits**: `defaultHours` and `defaultStrips` in `config.js`.

## Good to know

- **Connection server.** The two browsers find each other through the free PeerJS cloud server. It needs no setup, but it is a shared community service with no uptime guarantee. If your site gets busy, run your own PeerServer (or switch to a hosted realtime service) and put its address in `config.js`.
- **Strict networks (recommended setup).** Video and photos travel directly between the two devices. Some mobile and office networks block that, and the connection then has to go through a relay (TURN) server. To add one for free: sign up at metered.ca, create an app, open **TURN Server**, copy the credentials URL (it looks like `https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=...`) and paste it into `turnCredentialsUrl` in `config.js`.
- **Backgrounds load from the internet.** The cut-out model (about 12 MB, loaded only when someone picks a background) comes from jsDelivr and Google. The addresses are in `config.js`. On older phones the cut-out can be slow; "Off" turns it off.
- **Two people per booth.** A third person who opens the link is told the booth is full.
- **Sound.** The booth asks for the microphone as well as the camera. If someone blocks the microphone they can still join with video only. Headphones stop echo. Some phones only play the other person's voice after a tap, so the booth shows a "Tap to hear them" button when needed.
- **How the limits work.** The expiry time and strip limit are written into the booth code (for example `abcd-efgh-2kq9xz-10`). Editing them in the link leads to a different, empty booth, so the limits can't be changed by editing the link. With no backend, the strip count is kept on the two devices: it's a friendly limit, not a security feature.
- **Privacy.** Photos are never uploaded to a server. They exist only on the two devices until someone saves or shares the strip.
- **Who stands where.** The first person in the booth is on the left, the second on the right, on both screens and on the strip.
