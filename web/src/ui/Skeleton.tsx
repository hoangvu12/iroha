import type { CSSProperties, ReactNode, SyntheticEvent } from "react";
import { createContext, useContext } from "react";
import { Skeleton as Measured } from "skullet/react";
import { cn } from "./cn";

const SampleContext = createContext(false);

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
  data: T | null | undefined;
  sample: T;
  label: string;
  id?: string;
  error?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: (data: T) => ReactNode;
}) {
  const loading = data == null && !error;
  return (
    <Measured data={data} sample={sample} label={label} id={id} error={error || undefined} className={cn("skeleton-hold", className)} style={style}>
      {(d: T) =>
        loading ? (
          <SampleContext.Provider value>
            <Inert>
              <Sample render={() => children(d)} />
            </Inert>
          </SampleContext.Provider>
        ) : (
          children(d)
        )
      }
    </Measured>
  );
}

// `inert` keeps pointers and focus out, but events dispatched by script still reach the sample's handlers: stop them on the way down.
const stop = (e: SyntheticEvent) => {
  e.stopPropagation();
  e.preventDefault();
};
function Inert({ children }: { children: ReactNode }) {
  return (
    <div
      data-skeleton-content=""
      inert
      style={{ display: "contents" }}
      onClickCapture={stop}
      onAuxClickCapture={stop}
      onDoubleClickCapture={stop}
      onPointerDownCapture={stop}
      onMouseDownCapture={stop}
      onTouchStartCapture={stop}
      onKeyDownCapture={stop}
      onSubmitCapture={stop}
    >
      {children}
    </div>
  );
}

// Skullet re-sets each sample element's children with React.Children.map, which turns a single child into an array and crashes parts that take one element (`Tip`, a row's menu). Rendering the sample inside this component keeps its elements out of that walk.
function Sample({ render }: { render: () => ReactNode }) {
  return render();
}
