import { createTransport, type Transporter } from 'nodemailer';
import { CorreoSaliente, MailPort } from './mail.port';

export interface SmtpOpciones {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Envío por SMTP. En desarrollo apunta a Mailpit (captura sin entregar a nadie); con credenciales entrega de verdad. */
export class SmtpMail extends MailPort {
  private readonly transporte: Transporter;

  constructor(private readonly o: SmtpOpciones) {
    super();
    this.transporte = createTransport({
      host: o.host,
      port: o.port,
      secure: o.secure,
      ...(o.user ? { auth: { user: o.user, pass: o.pass ?? '' } } : {}),
    });
  }

  async enviar(c: CorreoSaliente): Promise<void> {
    await this.transporte.sendMail({
      from: this.o.from,
      to: c.para,
      subject: c.asunto,
      html: c.html,
      text: c.texto,
    });
  }
}
