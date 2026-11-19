import { useNavigate } from "react-router";
import { Maximize2, MessageCircle, Minimize2, SquarePen, X } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { useIsPhone } from "@/lib/media";
import { IconButton } from "@/ui/Button";
import { EmptyState } from "@/ui/States";

// Placeholder for ticket 23, which owns this folder. The shell renders
// <ChatPanel mode="sheet" /> in the right-side slot and /chat renders
// <ChatPanel mode="page" />. useChatPanel().request says what a Test button
// asked for (a Provider, Pool, Upstream Key, Gateway Key or Request).

export function ChatPanel({ mode }: { mode: "sheet" | "page" }) {
  const chat = useChatPanel();
  const navigate = useNavigate();
  const phone = useIsPhone();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-4">
        <h2 className="flex-1 text-[15px] font-semibold">Chat</h2>
        <IconButton icon={SquarePen} label="New chat" size="sm" disabled />
        {mode === "sheet" ? (
          <>
            <IconButton
              icon={Maximize2}
              label="Full page"
              size="sm"
              onClick={() => {
                chat.close();
                navigate("/chat");
              }}
            />
            <IconButton icon={X} label="Close" size="sm" onClick={chat.close} />
          </>
        ) : (
          !phone && (
            <IconButton
              icon={Minimize2}
              label="Back to the side panel"
              size="sm"
              onClick={() => {
                navigate(-1);
                chat.open();
              }}
            />
          )
        )}
      </header>
      <div className="flex flex-1 items-center justify-center overflow-y-auto">
        <EmptyState
          icon={MessageCircle}
          title="Test chats open here"
          description="Pick a model and send a message to try exactly the path a Caller would take."
        />
      </div>
    </div>
  );
}
