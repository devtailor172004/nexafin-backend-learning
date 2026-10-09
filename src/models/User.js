import pkg from 'sequelize';
const { DataTypes, Op } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sequelize, { isPostgres } from '../config/db.js';
import { categories } from '../utils/businessCategories.js';

const User = sequelize.define('User', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    uuid: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        allowNull: true,
        unique: true
    },
    fullName: {
        type: DataTypes.STRING(150),
        allowNull: false
    },
    email: {
        type: DataTypes.STRING(150),
        allowNull: false,
        unique: true,
        validate: {
            isEmail: {
                msg: "Please enter a valid email address."
            }
        }
    },
    mobile: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: true,
        validate: {
            is: {
                args: /^[0-9]{10}$/,
                msg: "Mobile number must be exactly 10 digits and contain only numbers."
            }
        }
    },
    password: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    role: {
        type: DataTypes.ENUM('Admin', 'Branch', 'Employee', 'Partner', 'User'),
        defaultValue: 'Admin',
        set(value) {
            if (value) {
                const trimmedVal = String(value).trim();
                this.setDataValue('role', trimmedVal);
                const ROLE_MAP = {
                    'Admin': 1,
                    'Branch': 2,
                    'Employee': 3,
                    'Partner': 4,
                    'User': 5
                };
                if (ROLE_MAP[trimmedVal]) {
                    this.setDataValue('role_id', ROLE_MAP[trimmedVal]);
                }
            }
        },
        validate: {
            isIn: {
                args: [['Admin', 'Branch', 'Employee', 'Partner', 'User']],
                msg: "Invalid role selected. Role must be one of: Admin, Branch, Employee, Partner, User."
            }
        }
    },
    createdById: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        }
    },
    // DB-enforced "only one Admin" guard. Both engines use a generated column
    // kept UNIQUE so that a second row evaluating to 1 is rejected; every
    // non-Admin row is NULL, and NULLs are exempt from the unique constraint.
    // MySQL uses IF(); Postgres uses the standard CASE expression.
    adminUniqueCheck: {
        type: isPostgres
            ? "INTEGER GENERATED ALWAYS AS (CASE WHEN role = 'Admin' THEN 1 ELSE NULL END) STORED"
            : 'INTEGER GENERATED ALWAYS AS (IF(role = "Admin", 1, NULL)) STORED',
        unique: true
    },
    shopname: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    business_category_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        set(value) {
            if (value === null || value === undefined || value === "") {
                this.setDataValue('business_category_id', null);
                return;
            }
            // If category name is passed, look up its index
            const indexByName = categories.findIndex(cat => cat.toLowerCase() === String(value).trim().toLowerCase());
            if (indexByName !== -1) {
                this.setDataValue('business_category_id', String(indexByName));
                return;
            }
            this.setDataValue('business_category_id', String(value).trim());
        },
        validate: {
            isValidCategory(value) {
                if (value === null || value === undefined || value === "") return;
                const id = parseInt(value, 10);
                if (isNaN(id) || id < 0 || id >= categories.length) {
                    throw new Error(`Invalid business category. Must be an integer index between 0 and ${categories.length - 1} or a valid business category name.`);
                }
            }
        }
    },
    progress: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    is_agreement: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    mainbalance: {
        type: DataTypes.DECIMAL(20, 2),
        allowNull: true
    },
    qrbalance: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    pgbalance: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    aepsbalance: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    lockamount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    role_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        set(value) {
            if (value !== null && value !== undefined && value !== "") {
                const id = parseInt(value, 10);
                this.setDataValue('role_id', id);
                const ROLE_REVERSE_MAP = {
                    1: 'Admin',
                    2: 'Branch',
                    3: 'Employee',
                    4: 'Partner',
                    5: 'User'
                };
                if (ROLE_REVERSE_MAP[id]) {
                    this.setDataValue('role', ROLE_REVERSE_MAP[id]);
                }
            } else {
                this.setDataValue('role_id', null);
            }
        },
        validate: {
            isValidRoleId(value) {
                if (value === null || value === undefined || value === "") return;
                const id = parseInt(value, 10);
                if (id < 1 || id > 6) {
                    throw new Error("Invalid role_id selected. Must be an integer between 1 and 6.");
                }
            }
        }
    },
    parent_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        }
    },
    company_id: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    company_name: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    cin: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    registered_address: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    company_category: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    gst_number: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    gst_legal_name: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    business_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    app_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    ios_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    kyc_step: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0
    },
    kyc_category: {
        type: DataTypes.ENUM('Business', 'KYC_Checks', 'Director', 'Ubos', 'Documents','Bank_Info'),
        allowNull: true,
        defaultValue: 'Business'
    },
    scheme_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    status: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    is_passwordchanged: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    address: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    city: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    state: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    pincode: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    pancard: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    pep_status: {
        type: DataTypes.ENUM('Yes', 'No', 'Not Applicable'),
        allowNull: true
    },
    has_more_than_10_percent_partnership: {
        type: DataTypes.ENUM('Yes', 'No'),
        allowNull: true
    },
    business_address: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    business_pincode: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    business_state: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    business_city: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    has_different_address: {
        type: DataTypes.ENUM('Yes', 'No'),
        allowNull: true
    },
    different_business_address: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    different_business_pincode: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    different_business_state: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    different_business_city: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    authority_aadharcard: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    pan_verification_status: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'pending'
    },
    business_type: {
        type: DataTypes.ENUM('Private Limited', 'Proprietorship', 'Partnership', 'HUF', 'Trust', 'UnicorpAss'),
        allowNull: true
    },
    bankname: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    accountnumber: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    accountHoldername: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    ifsccode: {
        type: DataTypes.STRING(20),
        allowNull: true
    },
    branchName: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    bank_proof: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    shop_image: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    profilepic: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    merchant_selfie: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    merchant_video: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    kyc: {
        type: DataTypes.ENUM('Pending', 'Approved', 'Rejected'),
        allowNull: true,
        defaultValue: 'Pending'
    },
    dob: {
        type: DataTypes.STRING(20),
        allowNull: true
    },
    tpin: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    latitude: {
        type: DataTypes.DECIMAL(10, 8),
        allowNull: true
    },
    longitude: {
        type: DataTypes.DECIMAL(11, 8),
        allowNull: true
    },
    digilocker_id: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    digilocker_registered: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    digilocker_reference_key: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    digilocker_verified_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    digilocker_reference_expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    pan_card_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    aadhar_card_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    business_proof_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    kyc_rejection_reason: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    expected_sales: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    authority_fullName: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    authority_pancard: {
        type: DataTypes.STRING(50),
        allowNull: true
    },
    authority_email: {
        type: DataTypes.STRING(150),
        allowNull: true
    },
    authority_pan_verification_status: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'pending'
    },
    is_blocked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false
    },
    // ---- Authentication hardening (Feature Seven) ----
    failed_login_attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    locked_until: {
        type: DataTypes.DATE,
        allowNull: true
    },
    // Any JWT issued before this instant is rejected (session revocation on
    // password reset). Set by revokeExistingSessions().
    password_changed_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    business_category: {
        type: DataTypes.VIRTUAL,
        get() {
            const id = parseInt(this.business_category_id, 10);
            if (!isNaN(id) && id >= 0 && id < categories.length) {
                return categories[id];
            }
            return null;
        },
        set(value) {
            this.business_category_id = value;
        }
    }
}, {
    tableName: 'users',
    timestamps: true,
    engine: 'InnoDB ROW_FORMAT=DYNAMIC',
    indexes: [
        { fields: ['role'] },
        { fields: ['kyc', 'updatedAt'] },
        { fields: ['createdById', 'createdAt'] },
        { fields: ['parent_id'] },
        { fields: ['mobile'] },
        { fields: ['email'] },
        { fields: ['digilocker_reference_key'] },
        { fields: ['pan_verification_status'] },
        { fields: ['status'] }
    ],
    hooks: {
        beforeCreate: async (user) => {
            if (user.role === 'Admin') {
                const adminCount = await User.count({ where: { role: 'Admin' } });
                if (adminCount > 0) {
                    throw new Error("Only one Admin is allowed in the system. An Admin user already exists!");
                }
            }
            if (user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(user.password, salt);
            }
        },
        beforeUpdate: async (user) => {
            if (user.changed('role') && user.role === 'Admin') {
                const adminCount = await User.count({
                    where: {
                        role: 'Admin',
                        id: { [Op.ne]: user.id }
                    }
                });
                if (adminCount > 0) {
                    throw new Error("Only one Admin is allowed in the system. An Admin user already exists!");
                }
            }
            if (user.changed('password')) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(user.password, salt);
            }
        },
        afterCreate: async (user, options) => {
            const Product = sequelize.models.Product;
            const MasterProduct = sequelize.models.MasterProduct;
            if (Product && MasterProduct) {
                const masterProducts = await MasterProduct.findAll({ transaction: options.transaction });
                if (masterProducts.length > 0) {
                    const productsToCreate = masterProducts.map(prod => ({
                        userId: user.id,
                        product_name: prod.name,
                        status: 'deactive'
                    }));
                    await Product.bulkCreate(productsToCreate, { transaction: options.transaction, ignoreDuplicates: true });
                }
            }
        }
    }
});

User.prototype.generateToken = function () {
    return jwt.sign(
        { id: this.id, uuid: this.uuid, role: this.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );
};

User.prototype.comparePassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

User.belongsTo(User, { as: 'Creator', foreignKey: 'createdById' });
User.hasMany(User, { as: 'CreatedUsers', foreignKey: 'createdById' });
User.belongsTo(User, { as: 'Parent', foreignKey: 'parent_id' });
User.hasMany(User, { as: 'Children', foreignKey: 'parent_id' });



export default User;