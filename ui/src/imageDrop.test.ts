import { describe, it, expect } from "vitest";
import { ACCEPTED_IMAGE_TYPES, IMAGE_ACCEPT, isAcceptedImage } from "./imageDrop";

// The <input accept> attribute is enforced by the browser for the file picker but
// NOT for drops, so isAcceptedImage is the only thing standing between a dropped
// file and the server. These cases are the ones a picker would have refused.
describe("isAcceptedImage", () => {
  const file = (type: string) => new File([new Blob(["x"])], "f", { type });

  it("accepts the JPEG and PNG types the pickers advertise", () => {
    expect(isAcceptedImage(file("image/jpeg"))).toBe(true);
    expect(isAcceptedImage(file("image/png"))).toBe(true);
  });

  it("rejects images the backend cannot probe, and non-images", () => {
    for (const type of ["image/gif", "image/heic", "image/svg+xml", "application/pdf", "text/plain"]) {
      expect(isAcceptedImage(file(type))).toBe(false);
    }
  });

  it("rejects a file whose type the browser could not determine", () => {
    expect(isAcceptedImage(file(""))).toBe(false);
  });
});

// The picker and the drop path must agree on what is allowed — if IMAGE_ACCEPT
// drifted from ACCEPTED_IMAGE_TYPES, a file the picker offers could be refused on
// drop (or vice versa).
describe("IMAGE_ACCEPT", () => {
  it("advertises exactly the types isAcceptedImage admits", () => {
    expect(IMAGE_ACCEPT.split(",")).toEqual([...ACCEPTED_IMAGE_TYPES]);
  });
});
