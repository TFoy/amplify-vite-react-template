import { CognitoJwtVerifier } from "aws-jwt-verify";

type ApiGatewayEvent = {
  headers?: Record<string, string | undefined>;
};

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getRequiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getAuthorizationHeader(event: ApiGatewayEvent) {
  const headers = event.headers ?? {};

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && value) {
      return value;
    }
  }

  return null;
}

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: getRequiredEnvironment("COGNITO_USER_POOL_ID"),
      tokenUse: "id",
      clientId: getRequiredEnvironment("COGNITO_USER_POOL_CLIENT_ID"),
    });
  }

  return verifier;
}

export async function getAuthenticatedUserSub(event: ApiGatewayEvent) {
  const authorizationHeader = getAuthorizationHeader(event);
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new Error("Sign in is required.");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  const payload = await getVerifier().verify(token);
  if (!payload.sub) {
    throw new Error("Authenticated user is missing sub claim.");
  }

  return payload.sub;
}

export function getUserScopedParameterName(prefix: string, userSub: string) {
  return `${prefix}/${userSub}`;
}
