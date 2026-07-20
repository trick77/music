import { describe, it, expect, vi } from "vitest";
import { reactStub, renderHook } from "./testHooks";

vi.mock("react", () => reactStub);

const { ACCEPTED_IMAGE_TYPES, IMAGE_ACCEPT, IMAGE_REJECT_MESSAGE, isAcceptedImage, useImageDrop } = await import("./imageDrop");

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

// useImageDrop is what actually stands between a dropped file and the server, and
// it owns the highlight flag. Driven here through the hook harness — the drag
// events are plain objects, since only the fields the hook reads matter.
describe("useImageDrop", () => {
  const image = (type = "image/png") => new File([new Blob(["x"])], "cover", { type });

  type DragStub = {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
    dataTransfer: { types: string[]; files: File[]; dropEffect: string };
  };

  // withFiles=false models a reorder drag (a queue or playlist row), which carries
  // no files and must leave every drop zone it crosses untouched.
  const drag = (files: File[] = [], withFiles = true): DragStub => ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { types: withFiles ? ["Files"] : ["text/plain"], files, dropEffect: "none" },
  });

  function mount(opts: { onReject?: (m: string) => void; disabled?: boolean } = {}) {
    const onFile = vi.fn();
    const view = renderHook(() => useImageDrop({ onFile, ...opts }));
    // Cast at the boundary: the hook only ever reads the fields DragStub carries.
    const props = () => view.result().dropProps as unknown as Record<string, (e: DragStub) => void>;
    return { onFile, view, props, dropping: () => view.result().dropping };
  }

  it("when a file drag enters, then the zone lights up and claims the drop", () => {
    const z = mount();
    const e = drag();

    z.props().onDragEnter(e);

    expect(z.dropping()).toBe(true);
    // Without preventDefault on BOTH dragenter and dragover the drop never fires.
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("when dragover fires, then it claims the drop and asks for a copy cursor", () => {
    const z = mount();
    const e = drag();

    z.props().onDragOver(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.dataTransfer.dropEffect).toBe("copy");
  });

  it("when a reorder drag crosses the zone, then it is ignored entirely", () => {
    const z = mount();
    const enter = drag([], false);
    const over = drag([], false);

    z.props().onDragEnter(enter);
    z.props().onDragOver(over);

    expect(z.dropping()).toBe(false);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("none"); // the row drag keeps its own cursor
  });

  it("when the pointer crosses child nodes, then the highlight stays steady", () => {
    // dragenter/dragleave also fire moving between children; without depth
    // counting the highlight would flicker on every internal boundary.
    const z = mount();

    z.props().onDragEnter(drag()); // onto the zone
    z.props().onDragEnter(drag()); // onto a child inside it
    z.props().onDragLeave(drag()); // off the parent, still inside the child
    expect(z.dropping()).toBe(true);

    z.props().onDragLeave(drag()); // finally out
    expect(z.dropping()).toBe(false);
  });

  it("when a stray dragleave arrives first, then the zone does not get stuck lit", () => {
    const z = mount();

    z.props().onDragLeave(drag()); // depth goes negative — must still settle at off
    expect(z.dropping()).toBe(false);

    z.props().onDragEnter(drag());
    expect(z.dropping()).toBe(true);
  });

  it("when a JPEG or PNG is dropped, then it is handed over and the highlight clears", () => {
    const z = mount();
    const file = image("image/jpeg");
    z.props().onDragEnter(drag());
    const e = drag([file]);

    z.props().onDrop(e);

    expect(z.onFile).toHaveBeenCalledWith(file);
    expect(z.dropping()).toBe(false);
    expect(e.preventDefault).toHaveBeenCalled();
    // Nested zones (a cover inside a card that also accepts drops) must not both fire.
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("when an unsupported file is dropped, then it is refused with the shared message", () => {
    // <input accept> is not enforced for drops, so this check is the only guard.
    const onReject = vi.fn();
    const z = mount({ onReject });

    z.props().onDrop(drag([new File([new Blob(["x"])], "doc", { type: "application/pdf" })]));

    expect(z.onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(IMAGE_REJECT_MESSAGE);
  });

  it("when an unsupported file is dropped with no reject handler, then it is silently refused", () => {
    const z = mount();

    z.props().onDrop(drag([new File([new Blob(["x"])], "doc", { type: "image/gif" })]));

    expect(z.onFile).not.toHaveBeenCalled();
  });

  it("when a drop carries no file at all, then nothing is uploaded", () => {
    const onReject = vi.fn();
    const z = mount({ onReject });

    z.props().onDrop(drag([]));

    expect(z.onFile).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("when the zone is disabled, then it neither lights up nor accepts a drop", () => {
    // Anonymous viewers: the surface renders, but nothing may be uploaded through it.
    const onReject = vi.fn();
    const z = mount({ onReject, disabled: true });
    const enter = drag();
    const drop = drag([image()]);

    z.props().onDragEnter(enter);
    z.props().onDragOver(drag());
    z.props().onDragLeave(drag());
    z.props().onDrop(drop);

    expect(z.dropping()).toBe(false);
    expect(z.onFile).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(drop.preventDefault).not.toHaveBeenCalled();
  });
});
