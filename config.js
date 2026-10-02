// Settings for the photobooth. You can deploy without changing anything here.

window.BOOTH_CONFIG = {
  // Options passed to PeerJS, the library that connects the two browsers.
  // Leave this empty to use the free PeerJS cloud server.
  //
  // If connections fail on mobile data or strict Wi-Fi, add your own TURN
  // relay here (services like Metered or Cloudflare offer one), for example:
  //
  // peerOptions: {
  //   config: {
  //     iceServers: [
  //       { urls: "stun:stun.l.google.com:19302" },
  //       { urls: "turn:YOUR_TURN_HOST:3478", username: "USER", credential: "PASSWORD" }
  //     ]
  //   }
  // },
  peerOptions: {},

  // Easiest way to add a TURN relay: create a free app at metered.ca, open
  // "TURN Server" > "Credentials", and paste the "fetch credentials" URL here.
  // It looks like https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=...
  // The booth loads relay servers from it each time someone turns on their camera.
  turnCredentialsUrl: "",

  // Where the "Same place" backgrounds load their person-cutout model from.
  // They load only when someone picks a background.
  mediapipe: {
    lib: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs",
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm",
    model: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
  },

  // Booth codes are prefixed with this on the connection server so they don't
  // clash with other sites using the same free server. Change it to anything unique.
  idPrefix: "ldbooth-",

  // Starting choices under "Booth options" on the landing page. People can
  // change them before opening a booth; their last choice is remembered.
  // defaultHours: how long a new booth link works (0 = no limit).
  // defaultStrips: how many strips can be taken in one booth (0 = no limit).
  defaultHours: 24,
  defaultStrips: 10
};
