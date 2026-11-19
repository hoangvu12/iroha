import type { ReactNode } from "react";
import { AVATAR_SRC, BANNER_SRC } from "@/app/brand";

/** C13: the Iroha art on the left, the form on the right. Phones get the form only. */
export function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <div className="relative hidden w-[53%] overflow-hidden md:block">
        <img src={BANNER_SRC} alt="" className="absolute inset-0 size-full object-cover object-[62%_50%]" draggable={false} />
      </div>
      <div className="flex flex-1 items-center justify-center py-12 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        {/* A rare screen: the column rises into place once as one piece while the art stays still
            (architecture.md "UI motion system"; under reduced motion a fade). */}
        <div className="mx-auto w-full max-w-[340px] animate-rise-in">
          <img src={AVATAR_SRC} alt="Iroha" width={52} height={52} className="mb-6 rounded-full" draggable={false} />
          {children}
        </div>
      </div>
    </div>
  );
}
