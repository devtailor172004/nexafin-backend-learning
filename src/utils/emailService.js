import nodemailer from 'nodemailer';

export const sendUserCreationEmail = async ({ email, password, url }) => {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '465', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        family: 4 // Force IPv4 to avoid ENETUNREACH IPv6 routing errors on cPanel/CloudLinux
    });

    const appName = process.env.APP_NAME || 'AppName';

    const mailOptions = {
        from: `"${appName} Support" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Account Created Successfully',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #4CAF50; text-align: center;">Account Created Successfully</h2>
                <p>Hello,</p>
                <p>Your account has been successfully created. You can log in using the credentials below:</p>
                <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Website URL</td>
                        <td style="padding: 8px; border: 1px solid #ddd;"><a href="${url}" target="_blank">${url}</a></td>
                    </tr>
                    <tr>
                        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Email/Username</td>
                        <td style="padding: 8px; border: 1px solid #ddd;">${email}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Password</td>
                        <td style="padding: 8px; border: 1px solid #ddd;"><code>${password}</code></td>
                    </tr>
                </table>
                <p>Please change your password after logging in for the first time.</p>
                <p>Regards,<br>Team ${appName}</p>
            </div>
        `,
    };

    return await transporter.sendMail(mailOptions);
};

export const sendForgotPasswordEmail = async ({ email, otp }) => {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '465', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        family: 4 // Force IPv4 to avoid ENETUNREACH IPv6 routing errors on cPanel/CloudLinux
    });

    const appName = process.env.APP_NAME || 'AppName';

    const mailOptions = {
        from: `"${appName} Support" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Reset Password OTP',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #4CAF50; text-align: center;">Reset Your Password</h2>
                <p>Hello,</p>
                <p>We received a request to reset your account password. Use the verification OTP below to proceed:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; padding: 10px 20px; background-color: #f4f4f4; border-radius: 5px; border: 1px dashed #ccc;">${otp}</span>
                </div>
                <p>This OTP is valid for 5 minutes. If you did not request a password reset, please ignore this email.</p>
                <p>Regards,<br>Team ${appName}</p>
            </div>
        `,
    };

    return await transporter.sendMail(mailOptions);
};
