import type { ReactNode } from "react";
import { AVATAR_SRC, BANNER_SRC } from "@/app/brand";
import { cn } from "@/ui/cn";
import { firstScreenRiseIn } from "@/ui/motion";

export function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <div className="relative hidden w-[53%] overflow-hidden md:block">
        <img src={BANNER_SRC} alt="" className="absolute inset-0 size-full object-cover object-[62%_50%]" draggable={false} />
      </div>
      <div className="flex flex-1 items-center justify-center py-12 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <div className={cn("mx-auto w-full max-w-[340px]", firstScreenRiseIn)}>
          <img src={AVATAR_SRC} alt="Iroha" width={52} height={52} className="mb-6 rounded-full" draggable={false} />
          {children}
        </div>
      </div>
    </div>
  );
}
