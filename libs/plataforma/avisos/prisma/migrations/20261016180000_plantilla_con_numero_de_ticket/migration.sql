-- El correo muestra el número de ticket, que es el de la prefactura que vendrá (reservado por comercial al abrir el pedido).
UPDATE "plantilla" SET
  "cuerpo_html" = replace("cuerpo_html", '<tr><td style="padding:4px 12px 4px 0;color:#5c5870">Pedido</td><td style="padding:4px 0"><strong>{{pedidoCodigo}}</strong></td></tr>', '<tr><td style="padding:4px 12px 4px 0;color:#5c5870">Ticket</td><td style="padding:4px 0"><strong>{{ticketNumero}}</strong></td></tr><tr><td style="padding:4px 12px 4px 0;color:#5c5870">Pedido</td><td style="padding:4px 0"><strong>{{pedidoCodigo}}</strong></td></tr>'),
  "cuerpo_texto" = replace("cuerpo_texto", E'Pedido: {{pedidoCodigo}}\n', E'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\n')
WHERE "codigo" = 'pumping_ticket_creado_jefe_base';
