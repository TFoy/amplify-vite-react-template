## AWS Amplify React+Vite Starter Template

This repository provides a starter template for creating applications using React+Vite and AWS Amplify, emphasizing easy setup for authentication, API, and database capabilities.

## Overview

This template equips you with a foundational React application integrated with AWS Amplify, streamlined for scalability and performance. It is ideal for developers looking to jumpstart their project with pre-configured AWS services like Cognito, AppSync, and DynamoDB.

## Site-Wide Auth And User Preferences

Authentication is now site-wide. Every page shows a user menu in the upper-left:

- signed-out users can open the menu and sign in
- signed-in users see their identity and can sign out from the same menu

Ticker defaults are stored per signed-in user in the `UserPreference` model:

- `schwab-market-info`
- `tasty-market-info`
- `tasty-chart`

Each page restores the last ticker used by that user instead of starting blank.

## Features

- **Authentication**: Setup with Amazon Cognito for secure user authentication.
- **API**: Ready-to-use GraphQL endpoint with AWS AppSync.
- **Database**: Real-time database powered by Amazon DynamoDB.

## Deploying to AWS

For detailed instructions on deploying your application, refer to the [deployment section](https://docs.amplify.aws/react/start/quickstart/#deploy-a-fullstack-app-to-aws) of our documentation.

## Schwab Market Info Setup

This project includes a `SchwabMarketInfo` page (`/schwab-market-info`) backed by an Amplify function and HTTP API routes:

- `GET /schwab/authorize`: starts Schwab OAuth
- `GET /schwab/callback`: OAuth callback handler
- `GET /schwab/status`: returns whether a stored Schwab token is still usable or refreshable
- `GET /schwab/market-info?symbol=...`: retrieves quote data from Schwab Level One Equities endpoint

Set your Schwab credentials in AWS Systems Manager Parameter Store:

```powershell
aws ssm put-parameter --name "/amplify/schwab/credentials/app-key" --type "SecureString" --value "YOUR_SCHWAB_APP_KEY" --overwrite
aws ssm put-parameter --name "/amplify/schwab/credentials/app-secret" --type "SecureString" --value "YOUR_SCHWAB_APP_SECRET" --overwrite
```

```git bash
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name "/amplify/schwab/credentials/app-key" --type "SecureString" --value "YOUR_SCHWAB_APP_KEY" --overwrite --region us-west-2
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name "/amplify/schwab/credentials/app-secret" --type "SecureString" --value "YOUR_SCHWAB_APP_SECRET" --overwrite
```

After deploying/sandbox synth, use the generated callback URL in your Schwab developer app:

- `amplify_outputs.json` -> `custom.schwab.callback_url`

If needed for local-only testing, you can also define:

- `VITE_SCHWAB_API_URL` (for example in `.env.local`) to point the frontend to your API base URL.

### Schwab tokens are now per user

Schwab OAuth tokens are no longer stored in one shared parameter. They are now stored per Cognito user under:

- `/amplify/schwab/oauth/tokens/<cognito-sub>`

That means each signed-in user must connect Schwab once to populate their own token record.

## Tasty Chart Setup

This project includes a `TastyChart` page (`/tasty-chart`) backed by an Amplify function and HTTP API routes:

- `GET /tasty/authorize`: starts TastyTrade OAuth
- `GET /tasty/callback`: OAuth callback handler
- `GET /tasty/market-info?symbol=...`: retrieves quote data from TastyTrade
- `GET /tasty/status`: returns whether OAuth is currently connected

This version uses the TastyTrade authorization code flow. Sign-in is launched in a dedicated popup page (`/tasty-auth-popup`), and the backend automatically refreshes access tokens when they expire.

Environment selection:

- Default is `prod`
- To use sandbox instead, change `TASTY_ENV` in [amplify/functions/tasty-market-info/resource.ts](c:\Users\thoma\VSCode\amplify-vite-react-template\amplify\functions\tasty-market-info\resource.ts) from `"prod"` to `"sandbox"`

Set your TastyTrade OAuth client credentials and session secret in AWS Systems Manager Parameter Store:

```powershell
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name "/amplify/tasty/credentials/client-id" --type "SecureString" --value "YOUR_TASTY_CLIENT_ID" --overwrite
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name "/amplify/tasty/credentials/client-secret" --type "SecureString" --value "YOUR_TASTY_CLIENT_SECRET" --overwrite
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name "/amplify/tasty/credentials/session-secret" --type "SecureString" --value "YOUR_RANDOM_SESSION_SECRET" --overwrite
```

After deploy/sandbox synth, register this exact callback URL in your TastyTrade OAuth app:

- `amplify_outputs.json` -> `custom.tasty.callback_url`

### Tasty OAuth tokens and credentials

- `client_id`: your TastyTrade OAuth app identifier (configured in SSM as `/amplify/tasty/credentials/client-id`)
- `client_secret`: your TastyTrade OAuth app secret (configured in SSM as `/amplify/tasty/credentials/client-secret`)
- `redirect_uri`: must exactly match `custom.tasty.callback_url`
- `session_secret`: any long random string used to sign the OAuth state cookie (configured in SSM as `/amplify/tasty/credentials/session-secret`)
- `authorization_code`: returned by TastyTrade after login
- `access_token`: short-lived token used for API calls (cached in `/amplify/tasty/oauth/tokens`)
- `refresh_token`: returned during token exchange and reused automatically (cached in `/amplify/tasty/oauth/tokens`)

### Tasty tokens are now per user

Tasty OAuth tokens are no longer shared across the whole app. They are now stored per Cognito user under:

- `/amplify/tasty/oauth/tokens/<cognito-sub>`

That means each signed-in user must complete Tasty OAuth once before using `TastyChart` or `TastyMarketInfo`.

## Tasty Market Info Setup

This project also includes a separate `TastyMarketInfo` page (`/tasty-market-info`) backed by a separate Amplify function and REST routes:

- `GET /tasty-rest/status`: checks whether the shared Tasty OAuth refresh token can mint a usable access token
- `GET /tasty-rest/market-info?symbol=...`: calls the TastyTrade REST market-data endpoint

What is reused from `TastyChart`:

- the same Tasty OAuth app
- the same popup login page (`/tasty-auth-popup`)
- the same shared token cache in `/amplify/tasty/oauth/tokens`

What is separate:

- separate frontend page component
- separate backend Lambda function
- separate API routes under `/tasty-rest/*`
- REST market-data call instead of the quote-streamer implementation used by `TastyChart`

No additional secrets are required beyond the existing Tasty OAuth setup:

- `/amplify/tasty/credentials/client-id`
- `/amplify/tasty/credentials/client-secret`
- `/amplify/tasty/credentials/session-secret`
- `/amplify/tasty/oauth/tokens` is populated after OAuth login and reused by both Tasty pages

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
