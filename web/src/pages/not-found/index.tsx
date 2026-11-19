import { Link } from "react-router";
import { Compass } from "lucide-react";
import { buttonClass } from "@/ui/Button";
import { EmptyState } from "@/ui/States";

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="Nothing lives at this address"
      description="The page may have moved. Providers is a good place to start."
      action={
        <Link to="/providers" className={buttonClass("primary")}>
          Go to Providers
        </Link>
      }
    />
  );
}
