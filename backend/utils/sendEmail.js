const sendEmail = async ({ email, subject, message, html }) => {
  if (!process.env.EMAIL_API_KEY) {
    throw new Error('EMAIL_API_KEY is required to send email through Brevo.');
  }
  if (!process.env.FROM_EMAIL) {
    throw new Error('FROM_EMAIL is required to send email through Brevo.');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': process.env.EMAIL_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Flex', email: process.env.FROM_EMAIL },
      to: [{ email }],
      subject,
      textContent: message,
      htmlContent: html,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Brevo email API request failed with HTTP ${response.status}: ${responseBody}`,
    );
  }
};

module.exports = sendEmail;
