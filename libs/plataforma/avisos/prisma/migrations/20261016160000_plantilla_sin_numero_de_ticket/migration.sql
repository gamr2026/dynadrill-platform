-- El correo no menciona un número de ticket propio: el ticket es la prefactura y su número lo asigna AS2.
UPDATE "plantilla" SET
  "cuerpo_html" = replace("cuerpo_html", '<tr><td style="padding:4px 12px 4px 0;color:#5c5870">Ticket</td><td style="padding:4px 0"><strong>{{codigo}}</strong></td></tr>', ''),
  "cuerpo_texto" = replace("cuerpo_texto", E'Ticket: {{codigo}}\n', '')
WHERE "codigo" = 'pumping_ticket_creado_jefe_base';
