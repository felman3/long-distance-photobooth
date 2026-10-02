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

  // Booth codes are prefixed with this on the connection server so they don't
  // clash with other sites using the same free server. Change it to anything unique.
  idPrefix: "ldbooth-"
};
