// The Worker passes its own Google client into DriveBackend, so google-auth-library (a Node
// library) is never used here. This stands in for it so it isn't bundled.
export class GoogleAuth {
  constructor() {
    throw new Error("google-auth-library isn't available on the hosted connector");
  }
}
