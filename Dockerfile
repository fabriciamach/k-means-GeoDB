FROM nginx:alpine

# 1. Limpa o diretório padrão do Nginx
RUN rm -rf /usr/share/nginx/html/*

# 2. Copia a configuração do Nginx (COOP/COEP para SharedArrayBuffer)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 3. Copia TODO o conteúdo da sua pasta src local para a pasta do servidor
# O comando abaixo pega o que está DENTRO de src e joga na raiz do Nginx
COPY src/ /usr/share/nginx/html/

EXPOSE 80