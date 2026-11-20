import { fireEvent, render, screen } from "@testing-library/react";
import { createAgent } from "@ui-sdk/react/agent";
import { expect, test, vi } from "vitest";
import { Copy } from "lucide-react";
import { Button, IconButton } from "./Button";
import { ProviderTile } from "./LogoTile";
import { Tip } from "./Tooltip";
import { Skeleton } from "./Skeleton";

const agent = createAgent();

type Row = { handle: string };
const SAMPLE: Row[] = [{ handle: "dashscope" }, { handle: "openrouter" }];

function Rows({ data }: { data: Row[] | undefined }) {
  return (
    <Skeleton data={data} sample={SAMPLE} label="Loading Providers">
      {(rows) => (
        <ul aria-label="Providers">
          {rows.map((r) => (
            <li key={r.handle}>
              <ProviderTile handle={r.handle} />
              {r.handle}
            </li>
          ))}
        </ul>
      )}
    </Skeleton>
  );
}

test("while loading, the sample is drawn hidden from screen readers, with the label read instead", () => {
  const { container } = render(<Rows data={undefined} />);
  expect(screen.getByText("Loading Providers")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Providers" })).toBeNull();
  expect(container.querySelector("[aria-busy=true]")).toBeTruthy();
});

test("a sample's logo tiles request no image, so loading costs no logo lookups", () => {
  const { container } = render(<Rows data={undefined} />);
  expect(container.querySelectorAll("img")).toHaveLength(0);
});

test("an agent sees no control of the sample while loading, and the real ones once data lands", async () => {
  const pressed = vi.fn();
  const Page = ({ data }: { data?: Row[] }) => (
    <Skeleton data={data} sample={SAMPLE} label="Loading Providers">
      {(rows) => rows.map((r) => <Button key={r.handle} onClick={() => pressed(r.handle)}>{`Test ${r.handle}`}</Button>)}
    </Skeleton>
  );
  const { rerender } = render(<Page />);
  expect(agent.snapshot().filter((e) => !e.offPage && e.component !== "more")).toEqual([]);

  rerender(<Page data={[{ handle: "acme" }]} />);
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  expect(entries.map((e) => e.label)).toEqual(["Test acme"]);
  const result = await agent.act({ steps: [{ ref: "Test acme", action: "press" }] });
  expect(result.ok, result.error?.message).toBe(true);
  expect(pressed).toHaveBeenCalledWith("acme");
});

// UI ticket 26: the browser's `inert` keeps people out, but a click dispatched by a
// script or an automation (or a browser without inert) still reached the sample's
// handlers and opened a sheet for the sample record.
test("a skeleton's rows take no click, press or key, even dispatched straight at them", () => {
  const pressed = vi.fn();
  const Page = ({ data }: { data?: Row[] }) => (
    <Skeleton data={data} sample={SAMPLE} label="Loading Providers">
      {(rows) => (
        <ul>
          {rows.map((r) => (
            <li key={r.handle} onClick={() => pressed(`row ${r.handle}`)} onKeyDown={() => pressed(`key ${r.handle}`)}>
              <Button onClick={() => pressed(r.handle)}>{`Test ${r.handle}`}</Button>
              <a href={`/providers/${r.handle}`} onClick={() => pressed(`link ${r.handle}`)} onPointerDown={() => pressed(`down ${r.handle}`)}>
                {r.handle}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Skeleton>
  );
  const { container, rerender } = render(<Page />);
  const poke = () => {
    for (const el of container.querySelectorAll("[skullet-loading] li, [skullet-loading] button, [skullet-loading] a")) {
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.click(el);
      fireEvent.keyDown(el, { key: "Enter" });
    }
  };
  poke();
  expect(pressed).not.toHaveBeenCalled();

  // Loading again after data (same Skeleton): Skullet draws the last rows as the skeleton; they are as inert.
  rerender(<Page data={[{ handle: "acme" }]} />);
  rerender(<Page data={undefined} />);
  expect(container.querySelectorAll("[skullet-loading] li").length).toBeGreaterThan(0);
  poke();
  expect(pressed).not.toHaveBeenCalled();

  // The real rows work.
  rerender(<Page data={[{ handle: "acme" }]} />);
  const real = screen.getAllByRole("button", { name: "Test acme" }).filter((b) => !b.closest("[skullet-loading], [skullet-exiting]"));
  expect(real).toHaveLength(1);
  fireEvent.click(real[0]);
  expect(pressed).toHaveBeenCalledWith("acme");
});

test("a skeleton's controls are inert, so they can't be focused", () => {
  const { container } = render(<Rows data={undefined} />);
  const guard = container.querySelector("[data-skeleton-content]");
  expect(guard?.hasAttribute("inert")).toBe(true);
  expect(guard?.contains(container.querySelector("[skullet-loading] li"))).toBe(true);
});

test("a sample with an inline trigger taking one element (a row's tooltip) draws its skeleton without crashing the page", () => {
  const { container } = render(
    <Skeleton data={undefined} sample={SAMPLE} label="Loading Endpoints">
      {(rows) => (
        <ul>
          {rows.map((r) => (
            <li key={r.handle}>
              <Tip label={`Copy ${r.handle}'s URL`}>
                <IconButton icon={Copy} label={`Copy ${r.handle}'s URL`} size="sm" />
              </Tip>
            </li>
          ))}
        </ul>
      )}
    </Skeleton>,
  );
  expect(screen.getByText("Loading Endpoints")).toBeTruthy();
  expect(container.querySelectorAll("li")).toHaveLength(2);
});

test("once data arrives the real rows show, with their logos", () => {
  const { container, rerender } = render(<Rows data={undefined} />);
  rerender(<Rows data={[{ handle: "acme" }]} />);
  const list = screen.getByRole("list", { name: "Providers" });
  expect(list.textContent).toBe("acme");
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("[aria-busy=true]")).toBeNull();
});
