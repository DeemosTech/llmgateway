import { redirect } from "next/navigation";

export default function Home() {
	return redirect("/login"); // or redirect to /signup if you prefer
}
