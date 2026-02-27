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

This project includes a `MarketInfo` page (`/market-info`) backed by an Amplify function and HTTP API routes:

- `GET /schwab/authorize`: starts Schwab OAuth
- `GET /schwab/callback`: OAuth callback handler
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

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
