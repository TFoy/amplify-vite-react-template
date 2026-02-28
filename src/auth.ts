import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth";

export async function getAuthHeaders() {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();

  if (!idToken) {
    throw new Error("Sign in is required.");
  }

  return {
    Authorization: `Bearer ${idToken}`,
  };
}

export async function isSignedIn() {
  try {
    await getCurrentUser();
    return true;
  } catch {
    return false;
  }
}
