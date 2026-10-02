# Long Distance Photobooth

Two people in different places open the same link, see each other live, and take a photo strip together. A shared countdown runs on both screens, each camera takes its own photo at full quality, and both people get the same strip to save.

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
| `config.js` | Connection settings you can change |
| `vendor/peerjs.min.js` | PeerJS 1.5.5, the library that connects the two browsers |
| `fonts/` | The three typefaces (open-source, SIL Open Font License) |

## Things you may want to change

- **Site name and text**: edit `index.html`.
- **Colours**: the variables at the top of `style.css`.
- **Paper colours for the strip**: the `PAPERS` list at the top of `app.js`.
- **Countdown speed**: `COUNT_MS` and `BETWEEN_MS` at the top of `app.js`.

## Good to know

- **Connection server.** The two browsers find each other through the free PeerJS cloud server. It needs no setup, but it is a shared community service with no uptime guarantee. If your site gets busy, run your own PeerServer (or switch to a hosted realtime service) and put its address in `config.js`.
- **Strict networks.** Video and photos travel directly between the two devices. Some mobile and office networks block that, and the connection then goes through a relay (TURN) server. PeerJS includes a basic one; for better reliability add your own in `config.js`.
- **Two people per booth.** A third person who opens the link is told the booth is full.
- **No sound.** The booth sends video only, so people usually stay on a call or chat while posing.
- **Privacy.** Photos are never uploaded to a server. They exist only on the two devices until someone saves or shares the strip.
- **Who stands where.** The first person in the booth is on the left, the second on the right, on both screens and on the strip.
