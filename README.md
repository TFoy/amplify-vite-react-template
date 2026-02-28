## AWS Amplify React+Vite Starter Template

This repository provides a starter template for creating applications using React+Vite and AWS Amplify, emphasizing easy setup for authentication, API, and database capabilities.

## Overview

This template equips you with a foundational React application integrated with AWS Amplify, streamlined for scalability and performance. It is ideal for developers looking to jumpstart their project with pre-configured AWS services like Cognito, AppSync, and DynamoDB.

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

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
