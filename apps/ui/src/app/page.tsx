import { redirect } from "next/navigation";

import { getUser } from "@/lib/getUser";

export default async function Home() {
	const user = await getUser();

	return redirect(user ? "/dashboard" : "/login");
}
