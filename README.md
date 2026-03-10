# Using Shannon with GitHub Copilot

This version includes the Copilot SDK. Because of this, it does not work with other LLM providers and is designed to run only with Claude.

If you already have Claude access, you can run Shannon directly.

If you want to run it for free using GitHub Copilot, you can clone this repository and follow the steps below.

## How it Works

A Node script is provided that mocks the VS Code authorization flow. The script extracts the GitHub OAuth token that VS Code normally uses for Copilot.

After extracting the token, add it to your environment variables as:

`COPILOT_GITHUB_TOKEN`

Once the token is set, the application will start working with GitHub Copilot.

## Important Disclaimer

GitHub issues Copilot tokens for specific applications such as VS Code. Using a mocked authorization flow to extract the token may violate GitHub’s Terms and Conditions.

Your Copilot access may be revoked if GitHub detects this behavior. Use this method at your own risk.
