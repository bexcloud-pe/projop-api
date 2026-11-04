const dotenv = require('dotenv');
const path = require('path');

dotenv.config({
    path: __dirname + `/../../.env.${process.env.NODE_ENV}`
});

module.exports = {
    NODE_ENV : process.env.NODE_ENV || 'development',
    PORT : process.env.PORT ,
    DB_USER : process.env.DB_USER,
    DB_HOST : process.env.DB_HOST,
    DB_PASSWORD : process.env.DB_PASSWORD,
    DB_DATABASE : process.env.DB_DATABASE,
    DB_PORT : process.env.DB_PORT,
    // Cantidad de proxies propios delante de la aplicación (Cloud Run agrega 1).
    // Define cuántos saltos de X-Forwarded-For se consideran confiables.
    TRUST_PROXY_HOPS : process.env.TRUST_PROXY_HOPS,
}