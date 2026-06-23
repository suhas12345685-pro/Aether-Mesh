# =============================================================================
# Aether Mesh — Nginx + Certbot image
# =============================================================================
FROM nginx:1.27-alpine

# Install certbot and its nginx plugin, plus envsubst for template rendering
RUN apk add --no-cache certbot certbot-nginx bash openssl

# Remove default config — we supply our own
RUN rm -f /etc/nginx/conf.d/default.conf /etc/nginx/nginx.conf

# Create necessary directories
RUN mkdir -p \
    /var/www/certbot \
    /etc/letsencrypt \
    /var/log/nginx

# Seed an empty upstream map so nginx doesn't error on first boot
# (before any tenants are provisioned)
RUN echo '# Aether tenant upstream map' > /etc/nginx/upstream.map

# ---- Certbot renewal helper ------------------------------------------------
COPY renew-certs.sh /usr/local/bin/renew-certs.sh
RUN chmod +x /usr/local/bin/renew-certs.sh

EXPOSE 80 443

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
