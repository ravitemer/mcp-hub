import express from 'express';

const app = express();
app.use(express.json());

// Basic health check endpoint
app.get('/health', (req, res) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    res.json({
        status: 'ok',
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

const port = process.env.PORT || 3001;

const server = app.listen(port, () => {
    console.log(`Server started on port ${port} with PID ${process.pid}`);
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Handle SIGINT gracefully
process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Export for testing
export default server;