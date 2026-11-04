const config = require('./config/config.js');
const cors = require('cors');
const express = require('express');
const app = express();

// Cantidad de proxies propios delante de la aplicación. Express descarta esa
// cantidad de saltos desde el final de X-Forwarded-For y toma el siguiente como
// req.ip, así los saltos que agregue el cliente quedan fuera. Un valor mayor al
// real permitiría falsificar la IP, por eso no se usa 'true'.
app.set('trust proxy', Number(config.TRUST_PROXY_HOPS) || 1);

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());


// Importación de routers modularizados
const categoriesRouterTest = require('./routes/categories.routes.js');
const companyRouterTest = require('./routes/company.routes.js');
const confItemsRouterTest = require('./routes/conf_items.routes.js');
const projectsRouterTest = require('./routes/projects.routes.js');
const ticketRoutes = require('./routes/tickets.routes.js');
const serviceCatalogRoutes = require('./routes/service-catalog.routes.js');
const timesheetRoutes = require('./routes/timesheet.routes.js');
const solutionCategoryRoutes = require('./routes/solution-category.routes.js');
// Uso de routers
app.use(categoriesRouterTest);
app.use(companyRouterTest);
app.use(confItemsRouterTest);
app.use(projectsRouterTest);
app.use(ticketRoutes);
app.use(timesheetRoutes);
app.use(serviceCatalogRoutes);
app.use(solutionCategoryRoutes);

// Ruta raíz
app.get('/', function(req, res) {
  res.json({ status: 'API is ready listen request from ' + config.PORT });
});

module.exports = app;
