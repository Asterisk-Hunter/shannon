const getCopilotToken = async () => {
    const clientId = '01ab8ac9400c4e429b23'; // VS Code Copilot Client ID

    console.log('Requesting device code...');

    const codeRes = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client_id: clientId,
            scope: 'read:user' // standard scope requested by the extension
        })
    });
    const codeData = await codeRes.json();

    console.log('\n======================================================');
    console.log(`ACTION REQUIRED:`);
    console.log(`1. Open your browser to: ${codeData.verification_uri}`);
    console.log(`2. Enter this exact code: ${codeData.user_code}`);
    console.log('======================================================\n');
    console.log('Polling for token... (waiting for you to approve in browser)');

    const interval = (codeData.interval || 5) * 1000;

    while (true) {
        await new Promise(resolve => setTimeout(resolve, interval));

        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                client_id: clientId,
                device_code: codeData.device_code,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
        });

        const tokenData = await tokenRes.json();

        if (tokenData.access_token) {
            console.log('\n✅ SUCCESS! Copy the token below:');
            console.log('------------------------------------------------------');
            console.log(tokenData.access_token);
            console.log('------------------------------------------------------');
            console.log('\nPaste this value into your .env file as:');
            console.log(`COPILOT_GITHUB_TOKEN=${tokenData.access_token}`);
            break;
        } else if (tokenData.error === 'authorization_pending') {
            // Still waiting for the user, keep polling
            process.stdout.write('.');
        } else if (tokenData.error === 'slow_down') {
            // We are polling too fast, add a delay, though standard interval should prevent this
            process.stdout.write('~');
        } else {
            console.error('\n❌ Error generating token:', tokenData.error, tokenData.error_description);
            break;
        }
    }
};

getCopilotToken().catch(console.error);
