import {createApp} from './app.ts';
import {loadEnvFiles} from './env.ts';

loadEnvFiles();
const {app}=await createApp();
const port=Number(process.env.PORT||4388);
app.listen(port,'127.0.0.1',()=>console.log(`monogram API ready at http://127.0.0.1:${port}`));
