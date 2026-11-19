import type { CSSProperties, ReactNode } from "react";
import { createContext, useContext } from "react";
import { Skeleton as Measured } from "skullet/react";
import { cn } from "./cn";

// Every loading state in the app is this: Skullet draws the skeleton from the
// real content, rendered from `sample` (or the shape last shown under `id`),
// so nothing moves when the data lands (docs/agents/architecture.md, "UI
// ticket 02"). Import it from here, not from skullet/react.

const SampleContext = createContext(false);

/** True while rendering the sample a skeleton is measured from: skip side effects such as loading logos. */
export const useIsSample = () => useContext(SampleContext);

export function Skeleton<T>({
  data,
  sample,
  label,
  id,
  error,
  className,
  style,
  children,
}: {
  /** Loading while null or undefined. Pass `query.data`; never force loading with `isFetching`, so a refetch keeps what is shown. */
  data: T | null | undefined;
  /** What the first skeleton is drawn from: a module constant of the API type, sized like typical data. */
  sample: T;
  /** Read to screen readers while loading: "Loading Providers". */
  label: string;
  /** Remembers the shape under this key, so a reload is drawn exactly (stable strings, not per record). */
  id?: string;
  /** Shown instead of the content when set (an ErrorState). */
  error?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: (data: T) => ReactNode;
}) {
  return (
    // `skeleton-hold` (styles/index.css) keeps a skeleton unseen for its first 150 ms.
    <Measured data={data} sample={sample} label={label} id={id} error={error || undefined} className={cn("skeleton-hold", className)} style={style}>
      {(d: T) =>
        d === sample ? (
          <SampleContext.Provider value>
            <Sample render={() => children(d)} />
          </SampleContext.Provider>
        ) : (
          children(d)
        )
      }
    </Measured>
  );
}

// Skullet walks the sample's element tree and re-sets each element's children
// with React.Children.map, which turns a single child into an array; a part
// that takes one element as its trigger (`Tip`, a row's menu) then crashes the page.
// Rendering the sample inside this component keeps its elements out of that walk.
function Sample({ render }: { render: () => ReactNode }) {
  return render();
}
