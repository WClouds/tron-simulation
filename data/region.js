const { regionModel } = require('../connection');
const { canon } = require('../utils/uid');

async function regionFind(args){
   
    const query = args.query || { };

    /* If ID is specified, utilize cache */
    if (args.id) { 
        
        return await regionModel.findOne({_id:await canon(args.id)}); }

    return await regionModel.find(query);
}

module.exports={
    regionFind
}