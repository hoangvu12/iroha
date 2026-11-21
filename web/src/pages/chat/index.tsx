import { ChatPanel } from "./ChatPanel";

export default function ChatPage() {
  return (
    <div className="h-[calc(100dvh-72px-env(safe-area-inset-bottom))] md:h-dvh">
      <ChatPanel mode="page" />
    </div>
  );
}
